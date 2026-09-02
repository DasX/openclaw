import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

/** Builds recovery instructions for context-overflow failures. */
export function buildContextOverflowRecoveryText(params: {
  duringCompaction?: boolean;
  preserveSessionMapping?: boolean;
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  activeSessionEntry?: SessionEntry;
}): string {
  const prefix = params.preserveSessionMapping
    ? "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session."
    : params.duringCompaction
      ? "⚠️ Context limit exceeded during compaction. I've reset our conversation to start fresh - please try again."
      : "⚠️ Context limit exceeded. I've reset our conversation to start fresh - please try again.";
  return prefix + "\n\nTry starting a fresh session or using a model with a larger context window.";
}
