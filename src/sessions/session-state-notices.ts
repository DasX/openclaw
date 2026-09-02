/** Stale-state notice text, coalescing keys, and watcher eligibility. */
import { createInboundDebouncer } from "../auto-reply/inbound-debounce.js";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
  type SessionEventTarget,
} from "../auto-reply/reply/session-event-handoff.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  type SystemEvent,
} from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";

const SESSION_STATE_CONTEXT_PREFIX = "session-state:";
const log = createSubsystemLogger("sessions/state-notices");
const notices = createInboundDebouncer<{
  sessionKey: string;
  agentId: string;
  target: SessionEventTarget;
  occurrence: SystemEvent;
}>({
  debounceMs: 20_000,
  buildKey: ({ sessionKey, target, occurrence }) =>
    JSON.stringify([
      sessionKey,
      target.sessionId,
      target.lifecycleRevision,
      target.generation,
      occurrence.contextKey,
    ]),
  onFlush: (items, createFlush) =>
    createFlush({
      dispatch: async (lifecycle) => {
        const latest = items.at(-1)!;
        const pending = peekSystemEventEntries(latest.sessionKey);
        // Polling/replacement owns cancellation before admission; never recreate a consumed notice.
        const occurrence = items
          .toReversed()
          .find((item) => pending.some((event) => event.id === item.occurrence.id))?.occurrence;
        if (!occurrence) {
          return;
        }
        const receipt = enqueueSessionEvent(occurrence.text, {
          agentId: latest.agentId,
          sessionKey: latest.sessionKey,
          source: "session",
          expectedTarget: latest.target,
          occurrence,
          onAdopted: lifecycle.onAdopted,
        });
        const outcome = await receipt.settled;
        if (outcome.status === "failed") {
          throw new Error(outcome.error ?? "Session state notice failed");
        }
      },
    }),
  onError: (error) => log.warn(`Session state notice was not delivered: ${String(error)}`),
});

function encodeNoticeTarget(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("hex");
}

export function decodeSessionStateNoticeContextKey(contextKey: string): string | undefined {
  if (!contextKey.startsWith(SESSION_STATE_CONTEXT_PREFIX)) {
    return undefined;
  }
  const encoded = contextKey.slice(SESSION_STATE_CONTEXT_PREFIX.length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    return undefined;
  }
  // encodeNoticeTarget always writes the hex of a valid UTF-8 session key, so a
  // payload that fails strict UTF-8 decoding is corrupt: fail closed instead of
  // letting U+FFFD collisions acknowledge an unrelated watcher cursor.
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(encoded, "hex"),
    );
  } catch {
    return undefined;
  }
}

// Terse on purpose: this line lands in model prompts, possibly repeatedly across
// turns. Text must stay byte-stable per frozen watermark so queue dedupe holds,
// and the reconciliation call must be self-contained (explicit target sessionKey).
function sessionStateNoticeText(targetSessionKey: string, lastSeenSequence: number): string {
  return `Session "${targetSessionKey}" changed (other actor). Reconcile before acting: session_status sessionKey "${targetSessionKey}" changesSince ${lastSeenSequence}.`;
}

function shouldWakeWatcher(watcherSessionKey: string): boolean {
  return !isSubagentSessionKey(watcherSessionKey);
}

// Bare keys (session.scope="global") are store-local per agent, but cursors, the
// system-event queue, and session-event turns are keyed by session key alone. A notice
// for one agent's child could be drained and acknowledged by another agent's global
// turn — a cross-A2A metadata leak plus a lost notification. Until watcher identity
// is agent-scoped end-to-end, such watchers get durable events and changesSince but
// no notices.
export function isNotifiableWatcherKey(watcherSessionKey: string): boolean {
  return parseAgentSessionKey(watcherSessionKey) != null;
}

export function enqueueSessionStateNotice(params: {
  watcherSessionKey: string;
  targetSessionKey: string;
  lastSeenSequence: number;
  queueOnly?: boolean;
}): void {
  const agentId = parseAgentSessionKey(params.watcherSessionKey)?.agentId;
  if (!agentId) {
    return;
  }
  const text = sessionStateNoticeText(params.targetSessionKey, params.lastSeenSequence);
  if (text.length > 4000) {
    throw new Error("Session state notice target exceeds the supported prompt bound");
  }
  const target =
    !params.queueOnly && shouldWakeWatcher(params.watcherSessionKey)
      ? captureSessionEventTarget(agentId, params.watcherSessionKey)
      : undefined;
  const occurrence = enqueueSystemEventEntry(
    text,
    withSystemEventOwner(
      {
        sessionKey: params.watcherSessionKey,
        contextKey: `${SESSION_STATE_CONTEXT_PREFIX}${encodeNoticeTarget(params.targetSessionKey)}`,
        replace: true,
      },
      agentId,
    ),
  );
  // Group/subagent notices remain passive context. Active notices coalesce by exact
  // watcher generation and changed target through the ordinary inbound debouncer.
  if (!target || !occurrence) {
    return;
  }
  void notices.enqueue({ sessionKey: params.watcherSessionKey, agentId, target, occurrence });
}
