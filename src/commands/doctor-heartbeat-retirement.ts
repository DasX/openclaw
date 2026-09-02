import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  prepareClawHeartbeatMigration,
  finishClawHeartbeatMigration,
} from "../claws/heartbeat-migration.js";
import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDefaultProactiveJobReceiptInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "../cron/default-proactive-job.js";
import { publishCronJobsStoreMutation, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import { validateLegacyHeartbeatConfig } from "./doctor-heartbeat-legacy.js";
import { migrateHeartbeatOutcomes } from "./doctor-heartbeat-outcome-migration.js";
import { maybeMigrateHeartbeatFilesToScratch } from "./doctor-heartbeat-scratch-migration.js";
import { isHeartbeatTaskCronJob } from "./doctor-heartbeat-task-identity.js";
import {
  maybeMigrateHeartbeatTasksToCron,
  migrateStoredHeartbeatTaskJobs,
} from "./doctor-heartbeat-task-migration.js";
import { migrateHeartbeatVisibility } from "./doctor/shared/channel-legacy-config-migrate.js";

function removeRetiredConfig(cfg: OpenClawConfig): OpenClawConfig {
  const next = inheritLegacyDefaultAgentId(cfg, structuredClone(cfg));
  if (next.agents?.defaults) {
    delete next.agents.defaults.heartbeat;
  }
  for (const entry of Object.values(next.agents?.entries ?? {})) {
    delete entry.heartbeat;
  }
  for (const entry of next.agents?.list ?? []) {
    delete entry.heartbeat;
  }
  for (const [channel, value] of Object.entries(next.channels ?? {})) {
    if (channel === "modelByChannel" || !isRecord(value)) {
      continue;
    }
    delete value.heartbeatVisibility;
    if (isRecord(value.accounts)) {
      for (const account of Object.values(value.accounts)) {
        if (!isRecord(account)) {
          continue;
        }
        delete account.heartbeatVisibility;
      }
    }
  }
  return next;
}

/** Data commits first. Any ambiguous input prevents config removal and remains retryable. */
export async function retireHeartbeatWithDoctor(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const cfg = inheritLegacyDefaultAgentId(sourceConfig, structuredClone(sourceConfig));
  migrateHeartbeatVisibility(cfg, []);
  validateLegacyHeartbeatConfig(cfg);
  const clawHandoff = await prepareClawHeartbeatMigration(cfg, { env });
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const monitors = await ensureHeartbeatMonitorJobs(cfg, storePath, env);
  const scratch = await maybeMigrateHeartbeatFilesToScratch({ cfg, env, shouldRepair: true });
  if (scratch.warnings.length) {
    throw new Error(scratch.warnings.join("\n"));
  }
  const tasks = await maybeMigrateHeartbeatTasksToCron({ cfg, env, shouldRepair: true });
  if (tasks.warnings.length) {
    throw new Error(tasks.warnings.join("\n"));
  }
  await migrateStoredHeartbeatTaskJobs(cfg, env);
  await migrateHeartbeatOutcomes(cfg, env);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const jobs = loadedCronStoreFromRows(loadCronRows(db, cronStoreKey(storePath))).store.jobs;
      if (jobs.some((job) => job.payload.kind === "heartbeat" || isHeartbeatTaskCronJob(job))) {
        throw new Error(
          "Legacy automation rows changed during cutover; config was retained. Stop the Gateway and rerun Doctor.",
        );
      }
      for (const agentId of new Set([...listAgentIds(cfg), ...monitors.keys()])) {
        const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
        if (!receipt || receipt.phase === "complete") {
          continue;
        }
        if (!jobs.some((job) => job.id === receipt.jobId)) {
          throw new Error(
            `Automation ${receipt.jobId} was deleted during cutover; legacy configuration was retained.`,
          );
        }
        recordDefaultProactiveJobInDatabase(db, storePath, agentId, receipt.jobId, Date.now());
      }
      publishCronJobsStoreMutation(db, cronStoreKey(storePath));
    },
    { env },
    { operationLabel: "doctor.heartbeat-cutover-complete" },
  );
  const next = removeRetiredConfig(cfg);
  await finishClawHeartbeatMigration(clawHandoff, next, { env }, monitors);
  return next;
}
