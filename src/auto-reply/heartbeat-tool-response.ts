// Deprecated stable SDK parser and type for historical heartbeat response reports.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";
import { assertCronJobScratchContent } from "../cron/scratch-contract.js";
import { readTrimmedStringAlias } from "../utils/string-readers.js";

/** Tool name used by heartbeat runs to report visible or silent progress. */
export const HEARTBEAT_RESPONSE_TOOL_NAME = "heartbeat_respond";

/** Allowed heartbeat response outcomes. */
const HEARTBEAT_TOOL_OUTCOMES = [
  "no_change",
  "progress",
  "done",
  "blocked",
  "needs_attention",
] as const;
type HeartbeatToolOutcome = (typeof HEARTBEAT_TOOL_OUTCOMES)[number];

/** Allowed heartbeat notification priorities. */
const HEARTBEAT_TOOL_PRIORITIES = ["low", "normal", "high"] as const;
type HeartbeatToolPriority = (typeof HEARTBEAT_TOOL_PRIORITIES)[number];

/** Normalized response emitted by the heartbeat response tool. */
export type HeartbeatToolResponse = {
  outcome: HeartbeatToolOutcome;
  notify: boolean;
  summary: string;
  notificationText?: string;
  reason?: string;
  priority?: HeartbeatToolPriority;
  nextCheck?: string;
  /** Complete replacement for the current heartbeat monitor's private scratch. */
  scratch?: string;
};

const OUTCOMES = new Set<string>(HEARTBEAT_TOOL_OUTCOMES);
const PRIORITIES = new Set<string>(HEARTBEAT_TOOL_PRIORITIES);

/** Validate and normalize unknown heartbeat tool output. */
export function normalizeHeartbeatToolResponse(value: unknown): HeartbeatToolResponse | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const outcome = readString(value.outcome);
  const notify = typeof value.notify === "boolean" ? value.notify : undefined;
  const summary = readString(value.summary);
  if (!outcome || !OUTCOMES.has(outcome) || notify === undefined || !summary) {
    return undefined;
  }

  const priority = readString(value.priority);
  const notificationText = readTrimmedStringAlias(value, ["notificationText", "notification_text"]);
  const reason = readString(value.reason);
  const nextCheck = readTrimmedStringAlias(value, ["nextCheck", "next_check"]);
  const scratch = typeof value.scratch === "string" ? value.scratch : undefined;
  if (scratch !== undefined) {
    try {
      assertCronJobScratchContent(scratch);
    } catch {
      return undefined;
    }
  }
  return {
    outcome: outcome as HeartbeatToolOutcome,
    notify,
    summary,
    ...(notificationText ? { notificationText } : {}),
    ...(reason ? { reason } : {}),
    ...(priority && PRIORITIES.has(priority)
      ? { priority: priority as HeartbeatToolPriority }
      : {}),
    ...(nextCheck ? { nextCheck } : {}),
    ...(scratch !== undefined ? { scratch } : {}),
  };
}
