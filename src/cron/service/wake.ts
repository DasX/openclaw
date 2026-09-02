import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
/** Manual cron wake helper for queueing system events into sessions. */
import {
  isSubagentSessionKey,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { isProactiveJobCutoverPending } from "../proactive-job-receipt.js";
import { resolveCronDeliverySessionKey } from "../session-target.js";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";

export function enqueueCronSystemEvent(
  state: CronServiceState,
  text: string,
  opts?: Parameters<CronServiceState["deps"]["enqueueSystemEvent"]>[1],
) {
  return state.deps.enqueueSystemEvent(text, opts);
}

/** Keeps safety notices with their creator and limits failure routes to explicit origins. */
export function enqueueCronNotification(
  state: CronServiceState,
  job: CronJob,
  text: string,
  kind: "auto-disabled" | "failure-alert",
): void {
  const sessionKey = kind === "failure-alert" ? resolveCronDeliverySessionKey(job) : job.sessionKey;
  const agentId =
    normalizeOptionalAgentId(job.agentId) ??
    normalizeOptionalAgentId(parseAgentSessionKey(sessionKey)?.agentId) ??
    normalizeOptionalAgentId(state.deps.resolveDefaultAgentId?.()) ??
    normalizeOptionalAgentId(state.deps.defaultAgentId);
  const deliveryContext =
    sessionKey || (kind === "auto-disabled" && agentId)
      ? state.deps.resolveOriginDeliveryContext?.({ agentId, sessionKey })
      : undefined;
  if (!state.deps.enqueueSessionEvent) {
    throw new Error("Session event execution is unavailable; restart the Gateway and retry");
  }
  state.deps.enqueueSessionEvent(text, {
    agentId,
    sessionKey,
    contextKey: `cron:${job.id}:${kind}`,
    deliveryContext,
  });
}

/** v4 wake adapter. Deferred input belongs to a concrete ordinary job, never next-user. */
export function wake(
  state: CronServiceState,
  opts: {
    mode: "now" | "next-heartbeat";
    text: string;
    expectedTarget?: SessionEventTarget;
    /**
     * Internal session key to enqueue the system event against. When omitted,
     * the dep resolves the configured system-agent target — wakes from a non-main
     * session would otherwise route to the wrong place. Callers wiring an
     * agent-tool `wake` should thread the resolved session key (e.g. from
     * `cron-tool`'s `resolveInternalSessionKey`) so the event lands on the
     * originating conversation lane.
     */
    sessionKey?: string;
    /** Agent paired with the original session, not the ambient default agent. */
    agentId?: string;
  },
) {
  const text = opts.text.trim();
  if (!text) {
    return { ok: false } as const;
  }
  const sessionKey = opts.sessionKey?.trim() || undefined;
  const agentId = opts.agentId?.trim() || undefined;
  if (sessionKey && isSubagentSessionKey(sessionKey)) {
    return { ok: false, reason: "unwakeable-session-key" } as const;
  }
  // Carry the originating session's channel-correct delivery context (e.g. the
  // bound Telegram topic/thread) so a wake routes back into that thread instead
  // of the chat root. A no-origin wake keeps the empty option shape so the Gateway adapter can
  // resolve the current system-agent owner and session atomically.
  const originDeliveryContext =
    opts.expectedTarget?.deliveryContext ??
    (sessionKey || agentId
      ? state.deps.resolveOriginDeliveryContext?.({ sessionKey, agentId })
      : undefined);
  const enqueueOpts =
    sessionKey || agentId
      ? {
          ...(sessionKey ? { sessionKey } : {}),
          ...(agentId ? { agentId } : {}),
          ...(originDeliveryContext ? { deliveryContext: originDeliveryContext } : {}),
          ...(opts.expectedTarget ? { expectedTarget: opts.expectedTarget } : {}),
        }
      : undefined;
  if (opts.mode === "now" || sessionKey) {
    if (!state.deps.enqueueSessionEvent) {
      return {
        ok: false,
        reason: "Session event execution is unavailable; restart the Gateway",
      } as const;
    }
    state.deps.enqueueSessionEvent(text, enqueueOpts);
    return { ok: true } as const;
  }
  const target = state.deps.resolveSessionEventTarget?.({ agentId });
  const job = state.store?.jobs.find((candidate) => {
    if (
      !target?.agentId ||
      !target.sessionKey ||
      !candidate.enabled ||
      isProactiveJobCutoverPending(state.deps.storePath, candidate) ||
      candidate.state.autoDisabled ||
      !["agentTurn", "systemEvent"].includes(candidate.payload.kind) ||
      !(candidate.sessionTarget === "main" || candidate.sessionTarget.startsWith("session:")) ||
      !Number.isFinite(candidate.state.nextRunAtMs)
    ) {
      return false;
    }
    const jobTarget = state.deps.resolveSessionEventTarget?.({
      agentId: candidate.agentId,
      sessionKey: candidate.sessionTarget.startsWith("session:")
        ? candidate.sessionTarget.slice(8)
        : undefined,
    });
    return jobTarget?.agentId === target.agentId && jobTarget.sessionKey === target.sessionKey;
  });
  if (!state.deps.cronEnabled || state.stopped || !job || !state.deps.deferSessionEvent) {
    return {
      ok: false,
      reason:
        "No enabled ordinary scheduled session job can receive this wake. Choose mode now or create an automation with a scheduled session turn.",
    } as const;
  }
  state.deps.deferSessionEvent(text, job, opts.expectedTarget);
  return { ok: true } as const;
}
