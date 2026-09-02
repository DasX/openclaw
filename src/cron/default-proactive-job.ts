/** Setup-owned default automation identity. Startup and config reload never provision jobs. */
import { randomUUID } from "node:crypto";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readDefaultProactiveJobReceipt,
  readDefaultProactiveJobReceiptInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "./proactive-job-receipt.js";
import { computeJobNextRunAtMs } from "./service/jobs-scheduling.js";
import { mutateCronJobsStore, resolveCronJobsStorePathFromConfig } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "./store/row-codec.js";
import type { CronJob } from "./types.js";

export {
  readDefaultProactiveJobReceiptInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "./proactive-job-receipt.js";

export const DEFAULT_PROACTIVE_PROMPT =
  "Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.";

export function createDefaultProactiveJob(
  cfg: OpenClawConfig,
  agentId: string,
  nowMs: number,
  cadenceMs = 30 * 60 * 1000,
): CronJob {
  const owner = normalizeAgentId(agentId);
  const sessionKey =
    cfg.session?.scope === "global"
      ? "global"
      : resolveAgentMainSessionKey({ cfg, agentId: owner });
  const job: CronJob = {
    id: randomUUID(),
    agentId: owner,
    name: `Proactive check (${owner})`,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: cadenceMs, anchorMs: nowMs },
    sessionTarget: `session:${sessionKey}`,
    sessionKey,
    wakeMode: "now",
    idleOnly: true,
    payload: { kind: "agentTurn", message: DEFAULT_PROACTIVE_PROMPT, skipIfScratchEmpty: true },
    delivery: { mode: "announce", target: "owner" },
    state: {},
  };
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
  return job;
}

/** Resolve setup's provider-owned cadence before publishing a staged first agent. */
export function resolveDefaultProactiveCadenceMs(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const provider = resolveDefaultModelForAgent({ cfg, agentId }).provider;
  return resolveBundledProviderPolicySurface(provider)?.resolveProactiveCadenceMs?.({
    provider,
    config: cfg,
    env,
  });
}

/** Call only from explicit setup/agent provisioning, never a reconciliation loop. */
export function provisionDefaultProactiveJob(
  cfg: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions & { cadenceMs?: number } = {},
): CronJob | undefined {
  // Fresh enrollment follows the ambient owner, not every auxiliary agent added later.
  if (normalizeAgentId(agentId) !== tryResolveAmbientOwnerAgentId(cfg)) {
    return undefined;
  }
  const storePath = resolveCronJobsStorePathFromConfig(cfg, options.env);
  const nowMs = Date.now();
  const previous = readDefaultProactiveJobReceipt(storePath, agentId, options);
  const cadenceMs =
    options.cadenceMs ??
    (previous ? undefined : resolveDefaultProactiveCadenceMs(cfg, agentId, options.env));
  const planned = createDefaultProactiveJob(cfg, agentId, nowMs, cadenceMs);
  const result = mutateCronJobsStore(
    storePath,
    ({ db, upsert }) => {
      const rows = loadCronRows(db, cronStoreKey(storePath));
      const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
      if (receipt) {
        if (receipt.phase !== "complete") {
          throw new Error(
            "Proactive migration is incomplete; run openclaw doctor --fix before provisioning.",
          );
        }
        return loadedCronStoreFromRows(rows).store.jobs.find((job) => job.id === receipt.jobId);
      }
      if (rows.some((row) => row.payload_kind === "heartbeat" && row.agent_id === agentId)) {
        throw new Error(
          "Legacy proactive state needs openclaw doctor --fix before agent provisioning.",
        );
      }
      const job = upsert(planned);
      recordDefaultProactiveJobInDatabase(db, storePath, agentId, job.id, nowMs);
      return job;
    },
    options,
  );
  return result;
}
