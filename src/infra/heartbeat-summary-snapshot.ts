/** Read-only v4 projections of canonical automation jobs and their conversion receipts. */
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadCronJobsStoreFromDatabase,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import type { CronJob } from "../cron/types.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { openExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db.js";
import { getLegacyHeartbeatJobIdsInDatabase } from "./heartbeat-compat.js";
import type { ProactiveDeliveryPolicy } from "./outbound/targets.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";

export type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  session?: string;
  ackMaxChars: number;
  deliveryPolicy?: ProactiveDeliveryPolicy;
};

/** Missing state is empty; unreadable or unmigrated state remains an explicit failure. */
export async function readHeartbeatSummarySnapshot(cfg: OpenClawConfig): Promise<CronJob[]> {
  const database = await openExistingOpenClawStateDatabaseReadOnly();
  if (!database) {
    return [];
  }
  try {
    if (readSqliteUserVersion(database.db) !== OPENCLAW_STATE_SCHEMA_VERSION) {
      throw new Error(
        "Automation diagnostics require a current shared database; run openclaw doctor --fix",
      );
    }
    const storePath = resolveCronJobsStorePathFromConfig(cfg, process.env, database.db);
    const jobs = loadCronJobsStoreFromDatabase(database.db, cronStoreKey(storePath)).store.jobs;
    const ids = new Set(getLegacyHeartbeatJobIdsInDatabase(cfg, database.db));
    return jobs.filter((job) => ids.has(job.id));
  } finally {
    database.walMaintenance.close();
  }
}

export function projectHeartbeatSummary(job?: CronJob): HeartbeatSummary {
  const enabled = Boolean(job?.enabled && !job.state.autoDisabled);
  const everyMs = job?.schedule.kind === "every" ? job.schedule.everyMs : null;
  return {
    enabled,
    every: enabled ? (everyMs ? `${everyMs}ms` : "scheduled") : "disabled",
    everyMs: enabled ? everyMs : null,
    prompt: job?.payload.kind === "agentTurn" ? job.payload.message : "",
    target:
      job?.delivery?.mode === "none"
        ? "none"
        : (job?.delivery?.target ?? job?.delivery?.channel ?? "none"),
    model: job?.payload.kind === "agentTurn" ? job.payload.model : undefined,
    session: job?.sessionTarget.startsWith("session:")
      ? job.sessionTarget.slice(8)
      : job?.sessionKey,
    ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    deliveryPolicy: job?.delivery
      ? {
          target: job.delivery.target ?? job.delivery.channel,
          channel: job.delivery.channel,
          to: job.delivery.to,
          accountId: job.delivery.accountId,
          directPolicy: job.delivery.directPolicy,
        }
      : undefined,
  };
}
