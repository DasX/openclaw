import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  rewindSessionToMessage,
} from "./session-accessor.js";
import { readSessionTranscriptDiscardedMessages } from "./session-accessor.sqlite-discarded-branch.js";
import {
  agentId,
  sessionKey,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";
import { waitForSessionTranscriptProjection } from "./session-transcript-reconcile.js";
import { readDiscardedBranchConversationTextForSession } from "./transcript.js";

const { createSession, createSiblingSession } = useSessionMessageCutFixtures();

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function messageText(event: unknown): string {
  const content = (event as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const first = content.find(
      (block): block is { text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string",
    );
    return first?.text ?? "";
  }
  return "";
}

describe("discarded session transcript branches", () => {
  it("reports turns a rewind cut away and the turns that survived", async () => {
    const { env, scope } = await createSession();

    await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });
    const entry = loadSessionEntry({ agentId, env, sessionKey });
    const rewoundSessionId = entry?.sessionId;
    expect(rewoundSessionId).toBeTruthy();
    expect(rewoundSessionId).not.toBe(scope.sessionId);
    const readScope = { agentId, env, sessionId: rewoundSessionId! };
    await waitForSessionTranscriptProjection(readScope);

    const discarded = readSessionTranscriptDiscardedMessages(readScope);

    // The cut keeps the whole tree and repoints the leaf, so the discarded turns
    // are still stored; only their active-path rows are gone.
    expect(discarded.events.map(messageText)).toEqual([
      "second prompt",
      "second answer",
      "inactive prompt",
    ]);
    expect(discarded.activeEvents?.map(messageText)).toEqual(["first prompt", "first answer"]);
    expect(
      readSessionTranscriptMessageEvents(readScope).map((active) => messageText(active.event)),
    ).toEqual(["first prompt", "first answer"]);
  });

  it("follows a branch switch instead of the stored order", async () => {
    const { env, scope } = await createSession({ activeLeafTarget: "off-path-user" });
    const readScope = { agentId, env, sessionId: scope.sessionId };
    await waitForSessionTranscriptProjection(readScope);

    const discarded = readSessionTranscriptDiscardedMessages(readScope);

    // The leaf targets the sibling branch, so the longer branch is the inactive one.
    expect(discarded.events.map(messageText)).toEqual([
      "first answer",
      "second prompt",
      "second answer",
    ]);
    expect(discarded.activeEvents?.map(messageText)).toEqual(["first prompt", "inactive prompt"]);
  });

  it("reads rewind exclusions as conversation text through the session facade", async () => {
    const { env } = await createSession();
    const stateDir = env.OPENCLAW_STATE_DIR!;

    await rewindSessionToMessage({ agentId, env, entryId: "user-2", sessionKey });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const entry = loadSessionEntry({ agentId, env, sessionKey });
      await waitForSessionTranscriptProjection({ agentId, env, sessionId: entry!.sessionId! });
      const branch = await readDiscardedBranchConversationTextForSession({ agentId, sessionKey });

      expect(branch.discarded.map((turn) => turn.text)).toEqual([
        "second prompt",
        "second answer",
        "inactive prompt",
      ]);
      expect(branch.retained?.map((turn) => turn.text)).toEqual(["first prompt", "first answer"]);
    });
  });

  it("reports no exclusions for a session that was never cut", async () => {
    const { env } = await createSession();
    const linearKey = `${sessionKey}:linear`;
    const linear = await createSiblingSession({
      env,
      headline: "only turn",
      sessionId: "discarded-branch-linear",
      sessionKey: linearKey,
    });
    const readScope = { agentId, env, sessionId: linear.sessionId };
    await waitForSessionTranscriptProjection(readScope);

    const discarded = readSessionTranscriptDiscardedMessages(readScope);

    expect(discarded.events).toEqual([]);
    // No discarded turns means no active-path scan is paid for.
    expect(discarded.activeEvents).toBeUndefined();
  });
});
