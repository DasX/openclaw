/** Database-backed per-job scratch storage, kept outside public cron job state. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { assertCronJobScratchContent } from "./scratch-contract.js";
import { cronStoreKey } from "./store/key.js";
import { getCronStoreKysely } from "./store/schema.js";

type CronJobScratch = {
  content: string;
  revision: number;
  sourceSha256?: string;
  updatedAtMs: number;
};

/**
 * Present scratch content plus the persisted revision. An unset scratch keeps a
 * tombstone row so `currentRevision` stays monotonic across unset/recreate and
 * stale compare-and-swap writers cannot resurrect old content.
 */
export type CronJobScratchState = {
  currentRevision: number;
  scratch?: CronJobScratch;
};

export type CronJobScratchWriteResult =
  | { ok: true; currentRevision: number; scratch?: CronJobScratch }
  | { ok: false; reason: "revision-conflict"; currentRevision: number };

function rowToState(row: {
  content: string | null;
  revision: number;
  source_sha256: string | null;
  updated_at_ms: number;
}): CronJobScratchState {
  if (row.content === null) {
    return { currentRevision: row.revision };
  }
  return {
    currentRevision: row.revision,
    scratch: {
      content: row.content,
      revision: row.revision,
      ...(row.source_sha256 ? { sourceSha256: row.source_sha256 } : {}),
      updatedAtMs: row.updated_at_ms,
    },
  };
}

function readScratchStateFromDatabase(
  db: DatabaseSync,
  storeKey: string,
  jobId: string,
): CronJobScratchState {
  const cronDb = getCronStoreKysely(db);
  const row = executeSqliteQuerySync(
    db,
    cronDb
      .selectFrom("cron_job_scratch")
      .select(["content", "revision", "source_sha256", "updated_at_ms"])
      .where("store_key", "=", storeKey)
      .where("job_id", "=", jobId),
  ).rows[0];
  return row ? rowToState(row) : { currentRevision: 0 };
}

/** Reads one job's scratch state without exposing it through cron list/history surfaces. */
export function readCronJobScratchState(
  storePath: string,
  jobId: string,
  options: OpenClawStateDatabaseOptions = {},
): CronJobScratchState {
  const { db } = openOpenClawStateDatabase(options);
  return readScratchStateFromDatabase(db, cronStoreKey(storePath), jobId);
}

/** Writes, clears, or compare-and-swaps one scratch row. */
export function writeCronJobScratch(params: {
  storePath: string;
  jobId: string;
  content: string | null;
  expectedRevision?: number;
  sourceSha256?: string;
  nowMs?: number;
  options?: OpenClawStateDatabaseOptions;
}): CronJobScratchWriteResult {
  if (params.content !== null) {
    assertCronJobScratchContent(params.content);
  }
  const storeKey = cronStoreKey(params.storePath);
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const cronDb = getCronStoreKysely(db);
      const { currentRevision } = readScratchStateFromDatabase(db, storeKey, params.jobId);
      const owningJob = executeSqliteQuerySync(
        db,
        cronDb
          .selectFrom("cron_jobs")
          .select("job_id")
          .where("store_key", "=", storeKey)
          .where("job_id", "=", params.jobId),
      ).rows[0];
      // Job ownership and scratch revision are one CAS boundary. An invocation
      // finishing after durable job deletion must not recreate orphan scratch.
      if (
        !owningJob ||
        (params.expectedRevision !== undefined && params.expectedRevision !== currentRevision)
      ) {
        return { ok: false, reason: "revision-conflict", currentRevision } as const;
      }
      const revision = currentRevision + 1;
      const sourceSha256 = params.content !== null ? params.sourceSha256?.trim() : undefined;
      // Full-row replace keeps semantics simple: a write without provenance also
      // clears a stale migration sha, and an unset leaves a revision tombstone.
      if (currentRevision > 0) {
        executeSqliteQuerySync(
          db,
          cronDb
            .deleteFrom("cron_job_scratch")
            .where("store_key", "=", storeKey)
            .where("job_id", "=", params.jobId),
        );
      }
      executeSqliteQuerySync(
        db,
        cronDb.insertInto("cron_job_scratch").values({
          store_key: storeKey,
          job_id: params.jobId,
          content: params.content,
          revision,
          ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}),
          updated_at_ms: nowMs,
        }),
      );
      if (params.content === null) {
        return { ok: true, currentRevision: revision } as const;
      }
      return {
        ok: true,
        currentRevision: revision,
        scratch: {
          content: params.content,
          revision,
          ...(sourceSha256 ? { sourceSha256 } : {}),
          updatedAtMs: nowMs,
        },
      } as const;
    },
    params.options,
    { operationLabel: "cron.scratch.write" },
  );
}

/** Deletes scratch only when its owning job is removed. */
export function deleteCronJobScratch(
  storePath: string,
  jobId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const storeKey = cronStoreKey(storePath);
      const cronDb = getCronStoreKysely(db);
      executeSqliteQuerySync(
        db,
        cronDb
          .deleteFrom("cron_job_scratch")
          .where("store_key", "=", storeKey)
          .where("job_id", "=", jobId),
      );
      return true;
    },
    options,
    { operationLabel: "cron.scratch.delete" },
  );
}

/** Hash used by doctor to prove the file it removes is the file it migrated. */
export function hashCronScratchSource(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
