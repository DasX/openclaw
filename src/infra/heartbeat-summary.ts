/** @deprecated v4 reporting projection; ordinary jobs own cadence and delivery. */
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronJobsStoreSync, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { getLegacyHeartbeatJobIds } from "./heartbeat-compat.js";
import { projectHeartbeatSummary, type HeartbeatSummary } from "./heartbeat-summary-snapshot.js";

export type { HeartbeatSummary } from "./heartbeat-summary-snapshot.js";

export function resolveHeartbeatSummaryForAgent(
  cfg: OpenClawConfig,
  agentId?: string,
): HeartbeatSummary {
  const owner = agentId ?? tryResolveAmbientOwnerAgentId(cfg);
  const ids = new Set(getLegacyHeartbeatJobIds(cfg));
  const job = loadCronJobsStoreSync(resolveCronJobsStorePathFromConfig(cfg)).jobs.find(
    (candidate) => ids.has(candidate.id) && candidate.agentId === owner,
  );
  return projectHeartbeatSummary(job);
}

export function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean {
  return resolveHeartbeatSummaryForAgent(cfg, agentId).enabled;
}

/** Explicit legacy SDK input is parsed only here; current config has no heartbeat keys. */
export function resolveHeartbeatIntervalMs(
  cfg: OpenClawConfig,
  overrideEvery?: string,
  heartbeat?: { every?: string },
): number | null {
  const input = overrideEvery ?? heartbeat?.every;
  if (input === undefined) {
    return resolveHeartbeatSummaryForAgent(cfg).everyMs;
  }
  try {
    const ms = parseDurationMs(input, { defaultUnit: "m" });
    return ms > 0 ? ms : null;
  } catch {
    return null;
  }
}
