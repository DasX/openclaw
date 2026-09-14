import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  iterateVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";

/** Off-path events scanned before a rewound session stops reporting exclusions. */
export const DISCARDED_BRANCH_EVENT_SCAN_LIMIT = 1_000;
/** Active-path messages scanned to protect retained content from exclusion. */
export const DISCARDED_BRANCH_ACTIVE_SCAN_LIMIT = 2_000;

export type SessionTranscriptDiscardedMessages = {
  /** Message events the session retains off its active path. */
  events: TranscriptEvent[];
  /** Active-path message events, or undefined when the scan limit made the read unsafe. */
  activeEvents?: TranscriptEvent[];
};

function parseTranscriptEvent(eventJson: string): TranscriptEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(eventJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as TranscriptEvent)
      : undefined;
  } catch {
    return undefined;
  }
}

function isMessageEvent(event: TranscriptEvent): boolean {
  return (event as { type?: unknown }).type === "message";
}

/**
 * Reads the message events a session keeps outside its active path.
 *
 * A message cut (Control UI rewind) keeps the whole event tree and repoints the
 * active leaf, so discarded turns stay in `transcript_events` while losing their
 * `session_transcript_active_events` row. The difference is the discarded branch.
 *
 * `activeEvents` is omitted when the active path exceeds
 * {@link DISCARDED_BRANCH_ACTIVE_SCAN_LIMIT}. Callers that subtract discarded
 * content must then keep everything: without the retained set they cannot tell a
 * discarded turn from one that survives on the active path.
 */
export function readSessionTranscriptDiscardedMessages(
  scope: SessionTranscriptReadScope,
): SessionTranscriptDiscardedMessages {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const rows = executeSqliteQuerySync(
      projection.database.db,
      getActiveTranscriptKysely(projection.database)
        .selectFrom("transcript_events as event")
        .leftJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "event.session_id")
            .onRef("active.event_seq", "=", "event.seq"),
        )
        .select(["event.event_json"])
        .where("event.session_id", "=", projection.resolved.sessionId)
        .where("active.event_seq", "is", null)
        .orderBy("event.seq", "desc")
        .limit(DISCARDED_BRANCH_EVENT_SCAN_LIMIT),
    );
    const events = rows.rows
      .flatMap((row) => {
        const event = parseTranscriptEvent(row.event_json);
        return event && isMessageEvent(event) ? [event] : [];
      })
      .toReversed();
    if (events.length === 0) {
      return { events };
    }
    const visible = resolveVisibleMessagePositions(projection);
    if (visible.total > DISCARDED_BRANCH_ACTIVE_SCAN_LIMIT) {
      return { events };
    }
    const activeEvents = Array.from(
      iterateVisibleMessageRange(projection, 0, visible.total),
      (entry) => entry.event,
    );
    return { activeEvents, events };
  });
}
