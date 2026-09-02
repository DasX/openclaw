// Resolves queue mode and admission policy for a reply turn.
import type { QueueSettings } from "./queue.js";

/** Queue decisions for messages that arrive while an agent run is active. */
export type ActiveRunQueueAction = "run-now" | "enqueue-followup";

/** Resolves whether an active session should run, queue, or drop a new inbound turn. */
export function resolveActiveRunQueueAction(params: {
  queueAdmissionState?: "empty" | "steering" | "ready";
  isActive: boolean;

  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
  resetTriggered?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive && (!params.queueAdmissionState || params.queueAdmissionState === "empty")) {
    return "run-now";
  }

  if (params.resetTriggered) {
    return "run-now";
  }
  if (params.queueAdmissionState && params.queueAdmissionState !== "empty") {
    return "enqueue-followup";
  }
  // The occurrence stays queued until its current session owner releases admission.
  if (params.shouldFollowup) {
    return "enqueue-followup";
  }
  return "run-now";
}
