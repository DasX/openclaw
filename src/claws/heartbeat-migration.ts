import { isDeepStrictEqual } from "node:util";
import { listAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { hashCronScratchSource } from "../cron/scratch-store.js";
import type { CronJob } from "../cron/types.js";
/** Doctor-only transfer of verified installed-artifact ownership across retirement. */
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import {
  CLAW_CRON_REF_SCHEMA_VERSION,
  CLAW_PORTABLE_HEARTBEAT_ID,
  upsertClawCronRef,
} from "./cron.js";
import { inspectClawWorkspaceFile } from "./lifecycle-delete-support.js";
import { readPortableHeartbeatState } from "./portable-heartbeat.js";
import { cacheClawInstallSchemaVersion } from "./provenance-runtime-read.js";
import { readClawInstallRecords, readClawInstallRecord } from "./provenance.js";
import { readClawWorkspaceFiles, deleteClawWorkspaceFileRecord } from "./workspace.js";

export async function prepareClawHeartbeatMigration(
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions,
) {
  const plans = [];
  for (const install of readClawInstallRecords(options)) {
    const agent = listAgentEntries(cfg).find((entry) => entry.id === install.agentId);
    if (!agent) {
      continue;
    }
    const files = readClawWorkspaceFiles(install.agentId, options);
    const file = files.find((entry) => entry.path === "HEARTBEAT.md");
    if (!agent.heartbeat && !file) {
      continue;
    }
    const stripped = { ...agent };
    delete stripped.heartbeat;
    const state = readPortableHeartbeatState(install.agentId, cfg, options);
    const alreadyRebased =
      state.ref !== undefined &&
      state.ref.job.sourceAgentDigest === digestClawAgentConfig(agent) &&
      install.agentConfigDigest === digestClawAgentConfig(stripped);
    if (!alreadyRebased && install.agentConfigDigest !== digestClawAgentConfig(agent)) {
      throw new Error(
        `Claw ${install.agentId} configuration drifted before heartbeat conversion; reconcile operator edits before Doctor can transfer ownership.`,
      );
    }
    for (const managed of files) {
      const inspected = await inspectClawWorkspaceFile(managed);
      const consumed =
        managed === file &&
        inspected.state === "missing" &&
        state.receipt &&
        state.scratch.scratch?.sourceSha256 === managed.contentDigest.replace(/^sha256:/, "");
      if (inspected.state !== "unchanged" && !consumed) {
        throw new Error(
          `Claw ${install.agentId} managed file ${managed.path} drifted before heartbeat conversion; it was not rebaselined.`,
        );
      }
    }
    const heartbeat = { ...cfg.agents?.defaults?.heartbeat, ...agent.heartbeat };
    const portable = {
      ...(heartbeat.every !== undefined ? { every: heartbeat.every } : {}),
      ...(heartbeat.activeHours ? { activeHours: heartbeat.activeHours } : {}),
      ...(heartbeat.lightContext !== undefined ? { lightContext: heartbeat.lightContext } : {}),
      ...(heartbeat.timeoutSeconds !== undefined
        ? { timeoutSeconds: heartbeat.timeoutSeconds }
        : {}),
      ...(heartbeat.isolatedSession !== undefined
        ? { isolatedSession: heartbeat.isolatedSession }
        : {}),
    };
    plans.push({ install, file, agent: structuredClone(agent), portable });
  }
  return plans;
}

export async function finishClawHeartbeatMigration(
  plans: Awaited<ReturnType<typeof prepareClawHeartbeatMigration>>,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions,
  convertedJobs: Map<string, CronJob>,
): Promise<void> {
  // File IO remains outside the commit section. Only the exact consumed source
  // may lose its managed-file ref; unrelated missing/edited files never qualify.
  for (const plan of plans) {
    if (plan.file && (await inspectClawWorkspaceFile(plan.file)).state !== "missing") {
      throw new Error(
        `Claw ${plan.install.agentId} HEARTBEAT.md was not consumed; ownership was retained.`,
      );
    }
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    for (const plan of plans) {
      const { install, file } = plan;
      const current = readClawInstallRecord(install.agentId, options);
      if (!isDeepStrictEqual(current, install)) {
        throw new Error(`Claw ${install.agentId} provenance changed during Doctor conversion.`);
      }
      const state = readPortableHeartbeatState(install.agentId, cfg, options);
      const converted = convertedJobs.get(install.agentId);
      if (
        !converted ||
        !state.job ||
        resolveCronJobConfigRevision(converted) !== resolveCronJobConfigRevision(state.job)
      ) {
        throw new Error(
          `Claw ${install.agentId} automation changed during conversion; ownership was not rebaselined.`,
        );
      }
      if (!state.receipt || !state.job) {
        throw new Error(
          `Claw ${install.agentId} converted job was deleted; no provenance was rebaselined.`,
        );
      }
      if (
        file &&
        state.scratch.scratch?.sourceSha256 !== file.contentDigest.replace(/^sha256:/, "")
      ) {
        throw new Error(
          `Claw ${install.agentId} scratch no longer proves the consumed source; ownership was retained.`,
        );
      }
      const agent = listAgentEntries(cfg).find((entry) => entry.id === install.agentId)!;
      const expectedAgent = { ...plan.agent };
      delete expectedAgent.heartbeat;
      if (!isDeepStrictEqual(agent, expectedAgent)) {
        throw new Error(
          `Claw ${install.agentId} configuration changed during conversion; provenance was retained.`,
        );
      }
      const nextDigest = digestClawAgentConfig(agent);
      const updated = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "claw_installs">>(db)
          .updateTable("claw_installs")
          .set({ agent_config_digest: nextDigest })
          .where("agent_id", "=", install.agentId)
          .where("agent_config_digest", "=", install.agentConfigDigest)
          .where("plan_integrity", "=", install.planIntegrity),
      );
      if (Number(updated.numAffectedRows) !== 1) {
        throw new Error("Claw provenance changed during conversion.");
      }
      if (file) {
        const live = readClawWorkspaceFiles(install.agentId, options).find(
          (item) => item.path === file.path,
        );
        if (!isDeepStrictEqual(live, file)) {
          throw new Error("Claw managed-file provenance changed during conversion.");
        }
        deleteClawWorkspaceFileRecord(install.agentId, file.path, options);
      }
      upsertClawCronRef(
        {
          schemaVersion: CLAW_CRON_REF_SCHEMA_VERSION,
          agentId: install.agentId,
          manifestId: CLAW_PORTABLE_HEARTBEAT_ID,
          declarationKey: `claw:${install.agentId}:${CLAW_PORTABLE_HEARTBEAT_ID}`,
          schedulerJobId: state.receipt.jobId,
          status: "complete",
          createdAtMs: install.addedAtMs,
          updatedAtMs: Date.now(),
          job: {
            heartbeat: plan.portable,
            sourceAgentDigest: digestClawAgentConfig(plan.agent),
            configRevision: resolveCronJobConfigRevision(state.job),
            ...(state.scratch.scratch
              ? { scratchDigest: hashCronScratchSource(state.scratch.scratch.content) }
              : {}),
          },
        },
        options,
      );
    }
  }, options);
  for (const plan of plans) {
    const agent = listAgentEntries(cfg).find((entry) => entry.id === plan.install.agentId)!;
    cacheClawInstallSchemaVersion(
      plan.install.agentId,
      plan.install.schemaVersion,
      digestClawAgentConfig(agent),
      options,
    );
  }
}
