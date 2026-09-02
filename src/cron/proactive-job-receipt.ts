/** Durable provisioning/cutover identity; no session or runner imports. */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readConfigMachineState,
  readConfigMachineStateInDatabase,
  writeConfigMachineStateInDatabase,
} from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";
const DefaultProactiveJobReceiptSchema = z
  .object({
    jobId: z.string().min(1),
    provisionedAtMs: z.number().int().nonnegative(),
    phase: z.enum(["pending", "complete"]),
    convertedJobIds: z.array(z.string().min(1)).optional(),
  })
  .strict();
type DefaultProactiveJobReceipt = z.infer<typeof DefaultProactiveJobReceiptSchema>;

function decodeDefaultProactiveJobReceipt(value: unknown): DefaultProactiveJobReceipt | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result = DefaultProactiveJobReceiptSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      "Invalid default automation cutover receipt; preserve this state and use a known-good backup or manual repair before retrying. Doctor cannot safely reconstruct it. No automation was recreated.",
    );
  }
  return result.data;
}

export function readDefaultProactiveJobReceipt(
  storePath: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): DefaultProactiveJobReceipt | undefined {
  return decodeDefaultProactiveJobReceipt(
    readConfigMachineState<unknown>(defaultProactiveJobReceiptKey(storePath, agentId), options),
  );
}

function defaultProactiveJobReceiptKey(storePath: string, agentId: string): string {
  return `automation-default:${cronStoreKey(storePath)}:${normalizeAgentId(agentId)}`;
}

export function readDefaultProactiveJobReceiptInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
): DefaultProactiveJobReceipt | undefined {
  return decodeDefaultProactiveJobReceipt(
    readConfigMachineStateInDatabase(db, defaultProactiveJobReceiptKey(storePath, agentId)),
  );
}

/** Doctor may adopt an existing job; keep this receipt even after the job is deleted. */
export function recordDefaultProactiveJobInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
  jobId: string,
  nowMs: number,
  phase: DefaultProactiveJobReceipt["phase"] = "complete",
): void {
  const previous = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
  if (previous && previous.jobId !== jobId) {
    throw new Error(
      `Agent ${agentId} already has a default automation cutover receipt; resolve the conflicting legacy job with Doctor.`,
    );
  }
  if (!previous || (previous.phase !== "complete" && phase === "complete")) {
    writeConfigMachineStateInDatabase(
      db,
      defaultProactiveJobReceiptKey(storePath, agentId),
      { ...previous, jobId, provisionedAtMs: previous?.provisionedAtMs ?? nowMs, phase },
      nowMs,
    );
  }
}

/** Converted tasks share the agent's one cutover; recording identity does not alter job bytes. */
export function recordConvertedProactiveJobInDatabase(
  db: DatabaseSync,
  storePath: string,
  agentId: string,
  jobId: string,
): void {
  const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
  if (!receipt) {
    throw new Error("Missing proactive cutover receipt");
  }
  if (receipt.convertedJobIds?.includes(jobId)) {
    return;
  }
  writeConfigMachineStateInDatabase(db, defaultProactiveJobReceiptKey(storePath, agentId), {
    ...receipt,
    convertedJobIds: [...(receipt.convertedJobIds ?? []), jobId],
  });
}

export function isProactiveJobCutoverPending(
  storePath: string,
  job: Pick<CronJob, "id" | "agentId">,
  db?: DatabaseSync,
): boolean {
  if (!job.agentId) {
    return false;
  }
  const receipt = db
    ? readDefaultProactiveJobReceiptInDatabase(db, storePath, job.agentId)
    : readDefaultProactiveJobReceipt(storePath, job.agentId);
  return (
    receipt?.phase === "pending" &&
    (receipt.jobId === job.id || receipt.convertedJobIds?.includes(job.id) === true)
  );
}
