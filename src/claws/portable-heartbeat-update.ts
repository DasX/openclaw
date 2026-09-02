import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { analyzeLegacyHeartbeatTasks } from "../commands/heartbeat-task-legacy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { hashCronScratchSource, writeCronJobScratch } from "../cron/scratch-store.js";
import { computeJobNextRunAtMs } from "../cron/service/jobs-scheduling.js";
import { mutateCronJobsStore } from "../cron/store.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { CLAW_PORTABLE_HEARTBEAT_ID, upsertClawCronRef, type ClawCronGateway } from "./cron.js";
import {
  assertPortableHeartbeatUnchanged,
  commitPortableHeartbeatImport,
  exportPortableHeartbeat,
  portableHeartbeatJob,
  publishPortableHeartbeat,
  readPortableHeartbeatSource,
  readPortableHeartbeatState,
} from "./portable-heartbeat.js";
import type { ClawAddPlan } from "./types.js";
import type { ClawUpdateAction, ClawUpdatePlan } from "./update-plan-types.js";

type State = ReturnType<typeof readPortableHeartbeatState>;
function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}
function sourceDigest(
  source: Awaited<ReturnType<typeof readPortableHeartbeatSource>>,
): string | undefined {
  return source
    ? digest({
        heartbeat: source.heartbeat,
        scratchDigest:
          source.scratch === undefined ? undefined : hashCronScratchSource(source.scratch),
      })
    : undefined;
}
export function portableHeartbeatStateDigest(state: State): string {
  return digest({
    receipt: state.receipt,
    ref: state.ref,
    revision: state.job ? resolveCronJobConfigRevision(state.job) : undefined,
    scratchRevision: state.scratch.currentRevision,
    authority: state.job?.runtimeAuthority,
    authorityRecovery: state.job?.runtimeAuthorityRecoveryRequired,
  });
}
export function portableHeartbeatDrift(state: State): boolean {
  return (
    !state.ref ||
    !state.receipt ||
    state.ref.schedulerJobId !== state.receipt.jobId ||
    state.ref.status !== "complete" ||
    state.receipt.phase !== "complete" ||
    !state.job ||
    Boolean(state.job.runtimeAuthority) ||
    state.job.runtimeAuthorityRecoveryRequired === true ||
    state.ref.job.configRevision !== resolveCronJobConfigRevision(state.job) ||
    state.ref.job.scratchDigest !==
      (state.scratch.scratch ? hashCronScratchSource(state.scratch.scratch.content) : undefined)
  );
}

export async function planPortableHeartbeatUpdate(
  target: ClawAddPlan,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions,
): Promise<ClawUpdateAction | undefined> {
  const source = await readPortableHeartbeatSource(target);
  const current = readPortableHeartbeatState(target.agent.finalId, cfg, options);
  if (!source && (!current.ref || current.ref.status === "removed")) {
    return undefined;
  }
  const desiredDigest = sourceDigest(source);
  const sameDeclaration =
    current.ref &&
    digest({
      heartbeat: current.ref.job.heartbeat,
      scratchDigest: current.ref.job.scratchDigest,
    }) === desiredDigest;
  const hasTasks =
    source?.scratch !== undefined && analyzeLegacyHeartbeatTasks(source.scratch).hasTasksBlock;
  let unrepresentable: string | undefined;
  if (current.ref && source) {
    try {
      exportPortableHeartbeat(target.agent.finalId, cfg, options);
    } catch (error) {
      unrepresentable = error instanceof Error ? error.message : String(error);
    }
  }
  const blocked =
    Boolean(unrepresentable) ||
    (current.ref ? portableHeartbeatDrift(current) : Boolean(current.receipt)) ||
    hasTasks ||
    Boolean(current.receipt?.convertedJobIds?.length);
  const action = blocked
    ? "manual"
    : !current.ref
      ? "add"
      : !source
        ? "release"
        : sameDeclaration
          ? "unchanged"
          : "change";
  return {
    kind: "cronJob",
    id: CLAW_PORTABLE_HEARTBEAT_ID,
    action,
    target: current.receipt?.jobId ?? `automation:${target.agent.finalId}`,
    blocked,
    currentDigest: portableHeartbeatStateDigest(current),
    ...(desiredDigest ? { desiredDigest } : {}),
    reason:
      unrepresentable ??
      (blocked
        ? "Receipt-owned automation or scratch was edited, deleted, or has unresolved ownership; preserve it and reconcile explicitly."
        : action === "release"
          ? "Release the portable artifact reference while retaining the ordinary automation, scratch, and history. Remove the job explicitly if no longer wanted."
          : "Import portable settings into the same ordinary automation; retain identity, history and scratch CAS."),
  };
}

export async function applyPortableHeartbeatUpdate(
  update: ClawUpdatePlan,
  target: ClawAddPlan,
  cfg: OpenClawConfig,
  options: OpenClawStateDatabaseOptions & { cronGateway?: ClawCronGateway },
) {
  const action = update.actions.find(
    (item) => item.id === CLAW_PORTABLE_HEARTBEAT_ID && item.kind === "cronJob",
  );
  if (!action || action.action === "unchanged") {
    return { appliedIds: [], rollback: async () => {} };
  }
  const source = await readPortableHeartbeatSource(target);
  if (sourceDigest(source) !== action.desiredDigest) {
    throw new Error("Portable source changed after consent; rebuild the Claw update plan.");
  }
  const before = readPortableHeartbeatState(update.agentId, cfg, options);
  if (action.currentDigest !== portableHeartbeatStateDigest(before) || action.blocked) {
    throw new Error("Portable automation changed after consent; rebuild the Claw update plan.");
  }
  const publish = () => publishPortableHeartbeat(update.agentId, cfg, options);
  if (action.action === "add" && source && !before.ref && !before.receipt) {
    return {
      appliedIds: [CLAW_PORTABLE_HEARTBEAT_ID],
      publish,
      rollback: async () => {},
      commit: () => {
        assertPortableHeartbeatUnchanged(
          readPortableHeartbeatState(update.agentId, cfg, options),
          before,
        );
        commitPortableHeartbeatImport(target, cfg, source, options);
      },
    };
  }
  if (!before.ref || !before.job || !before.receipt) {
    throw new Error("Portable ownership is missing; no job was provisioned.");
  }
  const previous = before.ref;
  const previousJob = before.job;
  const nowMs = Date.now();
  mutateCronJobsStore(
    before.storePath,
    ({ upsert }) => {
      const current = readPortableHeartbeatState(update.agentId, cfg, options);
      assertPortableHeartbeatUnchanged(current, before);
      if (!source) {
        upsertClawCronRef({ ...previous, status: "removed", updatedAtMs: nowMs }, options);
        return;
      }
      const converted = portableHeartbeatJob(
        cfg,
        update.agentId,
        source.heartbeat,
        previousJob.createdAtMs,
      );
      const job = {
        ...previousJob,
        enabled: converted.enabled,
        schedule: converted.schedule,
        activeHours: converted.activeHours,
        sessionTarget: converted.sessionTarget,
        sessionKey: converted.sessionKey,
        payload: converted.payload,
        updatedAtMs: nowMs,
      };
      if (job.schedule.kind === "every" && previousJob.schedule.kind === "every") {
        job.schedule.anchorMs = previousJob.schedule.anchorMs;
      }
      job.state = { ...previousJob.state, nextRunAtMs: computeJobNextRunAtMs(job, nowMs) };
      const written = upsert(job);
      if (source.scratch !== current.scratch.scratch?.content) {
        const result = writeCronJobScratch({
          storePath: current.storePath,
          jobId: job.id,
          content: source.scratch ?? null,
          expectedRevision: current.scratch.currentRevision,
          options,
        });
        if (!result.ok) {
          throw new Error("Portable scratch changed during update.");
        }
      }
      upsertClawCronRef(
        {
          ...previous,
          updatedAtMs: nowMs,
          job: {
            heartbeat: source.heartbeat,
            configRevision: resolveCronJobConfigRevision(written),
            ...(source.scratch === undefined
              ? {}
              : { scratchDigest: hashCronScratchSource(source.scratch) }),
          },
        },
        options,
      );
    },
    options,
  );
  const after = readPortableHeartbeatState(update.agentId, cfg, options);
  return {
    appliedIds: [CLAW_PORTABLE_HEARTBEAT_ID],
    publish,
    rollback: async () => {
      mutateCronJobsStore(
        before.storePath,
        ({ upsert }) => {
          const current = readPortableHeartbeatState(update.agentId, cfg, options);
          assertPortableHeartbeatUnchanged(current, after);
          if (!current.job) {
            throw new Error("Automation disappeared before rollback; current state was retained.");
          }
          upsert({
            ...previousJob,
            state:
              stableStringify(current.job.state) === stableStringify(after.job?.state)
                ? previousJob.state
                : {
                    ...current.job.state,
                    nextRunAtMs: computeJobNextRunAtMs(
                      { ...previousJob, state: current.job.state },
                      Date.now(),
                    ),
                  },
            updatedAtMs: Date.now(),
          });
          if (before.scratch.scratch?.content !== current.scratch.scratch?.content) {
            const restored = writeCronJobScratch({
              storePath: current.storePath,
              jobId: previousJob.id,
              content: before.scratch.scratch?.content ?? null,
              expectedRevision: current.scratch.currentRevision,
              options,
            });
            if (!restored.ok) {
              throw new Error("Portable scratch changed before rollback.");
            }
          }
          upsertClawCronRef(previous, options);
        },
        options,
      );
      await publish();
    },
  };
}
