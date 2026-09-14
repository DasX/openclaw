import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import {
  readDiscardedBranchConversationTextForSession,
  readRecentUserAssistantTextForSession,
} from "../../config/sessions/transcript.js";
import { runPreparedChannelTurn } from "../turn/execution.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

vi.mock("../../config/sessions/transcript.js", () => ({
  readDiscardedBranchConversationTextForSession: vi.fn(),
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecent = vi.mocked(readRecentUserAssistantTextForSession);
const readDiscardedBranch = vi.mocked(readDiscardedBranchConversationTextForSession);

function context(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "continue",
    RawBody: "continue",
    CommandBody: "continue",
    From: "slack:channel:C1",
    To: "channel:C1",
    SessionKey: "agent:main:slack:channel:c1",
    AgentId: "main",
    Provider: "slack",
    Timestamp: 4_000,
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 3 },
    ...overrides,
  };
}

describe("session transcript inbound context", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    readRecent.mockReset();
    readDiscardedBranch.mockReset();
    readDiscardedBranch.mockResolvedValue({ discarded: [], retained: [] });
  });

  it("restores Slack assistant context when the live window is empty after restart", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "deploy at noon", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "I will remind you at 11:50", timestamp: 2_000 },
    ]);
    const ctx = context();

    await runPreparedChannelTurn({
      channel: "slack",
      routeSessionKey: ctx.SessionKey!,
      storePath: path.join(tempDirs.make("openclaw-session-transcript-context-"), "sessions.json"),
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: vi.fn(async () => ({ queuedFinal: false })),
    });

    expect(ctx.InboundHistory).toEqual([
      { messageId: "session:u1", sender: "User", body: "deploy at noon", timestamp: 1_000 },
      {
        messageId: "session:a1",
        sender: "Assistant",
        body: "I will remind you at 11:50",
        timestamp: 2_000,
      },
    ]);
  });

  it("restores marked Cron delivery context when no live chat window survives", async () => {
    readRecent.mockImplementation(async (params) =>
      params.includeCronDirectDeliveryContext
        ? [{ id: "cron-1", role: "assistant", text: "scheduled payload", timestamp: 2_000 }]
        : [],
    );
    const ctx = context({
      SessionTranscriptContext: { chatWindow: true, historyLimit: 3 },
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        source: "session",
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [expect.objectContaining({ body: "scheduled payload" })],
        }),
      }),
    ]);
  });

  it("dedupes the canonical turn against the live window and merges chronologically", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "cached user turn", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "canonical reply", timestamp: 2_000 },
    ]);
    const ctx = context({
      InboundHistory: [
        { sender: "Alice", body: "cached user turn", timestamp: 1_000, messageId: "m1" },
        { sender: "Alice", body: "new live turn", timestamp: 3_000, messageId: "m2" },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "cached user turn",
      "canonical reply",
      "new live turn",
    ]);
  });

  it("uses channel projection ids to avoid duplicating rendered assistant replies", async () => {
    readRecent.mockResolvedValue([
      { id: "a1", role: "assistant", text: "**same answer**", timestamp: 2_000 },
      {
        id: "a2",
        role: "assistant",
        text: "[[reply_to_current]]Legacy answer",
        timestamp: 2_500,
      },
      { id: "u2", role: "user", text: "follow-up", timestamp: 3_000, sourceChannel: "gateway" },
    ]);
    const ctx = context({
      SessionTranscriptContext: {
        historyLimit: 3,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          sessionTranscriptDedupeMessageIds: ["a1"],
          sessionTranscriptAssistantTextDedupeKeys: ["text:2500:Legacy answer"],
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              { message_id: "42", sender: "OpenClaw (you)", body: "same answer" },
              {
                message_id: "43",
                sender: "OpenClaw (you)",
                body: "Legacy answer",
                timestamp_ms: 2_500,
              },
            ],
          },
        },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(readRecent.mock.calls[0]?.[0]).not.toHaveProperty("includeCronDirectDeliveryContext");
    expect(ctx.ChannelStructuredContext?.[0]).toMatchObject({
      source: "session",
      payload: {
        messages: [
          { message_id: "42", body: "same answer" },
          { message_id: "43", body: "Legacy answer" },
          { message_id: "session:u2", sender: "User (gateway)", body: "follow-up" },
        ],
      },
    });
  });

  it("keeps a reply target bounded when it consumes the full window", async () => {
    readRecent.mockResolvedValue([
      { id: "a1", role: "assistant", text: "older reply", timestamp: 1_000 },
    ]);
    const ctx = context({
      SessionTranscriptContext: { chatWindow: true, historyLimit: 1 },
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          type: "chat_window",
          payload: { messages: [{ body: "target", is_reply_target: true }] },
        },
      ],
    });

    await mergeSessionTranscriptContext({
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.ChannelStructuredContext?.[0]?.payload).toEqual({
      messages: [{ body: "target", is_reply_target: true }],
    });
  });

  it("preserves a provider-owned thread window while enriching a populated session prompt", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "canonical question", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "canonical reply", timestamp: 2_000 },
    ]);
    const graphMessages = [
      { message_id: "graph-parent", sender: "Parent", body: "Graph parent" },
      { message_id: "graph-reply", sender: "Teammate", body: "Graph reply" },
    ];
    const ctx = context({
      ChatType: "channel",
      InboundHistory: [
        { messageId: "pending", sender: "Pending", body: "pending backlog", timestamp: 3_000 },
      ],
      SessionTranscriptContext: { historyLimit: 2 },
      ChannelStructuredContext: [
        {
          label: "Thread history",
          source: "msteams",
          type: "chat_window",
          sessionTranscriptMode: "preserve",
          payload: {
            order: "chronological",
            relation: "before_current_message",
            messages: graphMessages,
          },
        },
      ],
    });

    let prompt = "";
    await runPreparedChannelTurn({
      channel: "msteams",
      routeSessionKey: ctx.SessionKey!,
      storePath: path.join(tempDirs.make("openclaw-teams-transcript-context-"), "sessions.json"),
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: vi.fn(async () => {
        prompt = buildInboundUserContextPrefix(ctx, { timezone: "UTC" });
        return { queuedFinal: false };
      }),
    });

    expect(ctx.ChannelStructuredContext?.[0]?.source).toBe("msteams");
    expect(asRecord(ctx.ChannelStructuredContext?.[0]?.payload).messages).toEqual(graphMessages);
    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "canonical reply",
      "pending backlog",
    ]);
    expect(prompt).toContain("Graph parent");
    expect(prompt).toContain("Graph reply");
    expect(prompt).toContain("canonical reply");
    expect(prompt).toContain("pending backlog");
  });

  it("drops a rewound branch that the channel chat window still caches", async () => {
    // A/B/C -> rewind before B -> D in the same topic replying to retained A.
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 },
    ]);
    readDiscardedBranch.mockResolvedValue({
      discarded: [
        { id: "u2", role: "user", text: "discarded question", timestamp: 2_000 },
        { id: "a2", role: "assistant", text: "discarded answer", timestamp: 2_500 },
      ],
      retained: [{ id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 }],
    });
    const ctx = context({
      Provider: "telegram",
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              {
                message_id: "1",
                sender: "User",
                body: "retained topic starter",
                timestamp_ms: 1_000,
              },
              { message_id: "2", sender: "User", body: "discarded question", timestamp_ms: 2_100 },
              { message_id: "3", sender: "Bot", body: "discarded answer", timestamp_ms: 2_600 },
            ],
          },
        },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(asRecord(ctx.ChannelStructuredContext?.[0]?.payload).messages).toEqual([
      expect.objectContaining({ body: "retained topic starter" }),
    ]);
  });

  it("drops a rewound branch that the prepared inbound history still carries", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 },
    ]);
    readDiscardedBranch.mockResolvedValue({
      discarded: [{ id: "u2", role: "user", text: "discarded question", timestamp: 2_000 }],
      retained: [{ id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 }],
    });
    const ctx = context({
      InboundHistory: [
        { messageId: "1", sender: "User", body: "retained topic starter", timestamp: 1_000 },
        { messageId: "2", sender: "User", body: "discarded question", timestamp: 2_100 },
        { messageId: "4", sender: "User", body: "new turn after rewind", timestamp: 3_500 },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "retained topic starter",
      "new turn after rewind",
    ]);
  });

  it("drops every cached chunk of a discarded reply the channel had to split", async () => {
    const firstChunk = "Here is the first half of a long discarded answer about the deploy plan.";
    const secondChunk = "And here is the second half, which the channel sent as its own message.";
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 },
    ]);
    readDiscardedBranch.mockResolvedValue({
      // The transcript holds one canonical assistant turn; the channel cached two.
      discarded: [
        { id: "a2", role: "assistant", text: `${firstChunk}\n\n${secondChunk}`, timestamp: 2_500 },
      ],
      retained: [{ id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 }],
    });
    const ctx = context({
      InboundHistory: [
        { messageId: "1", sender: "User", body: "retained topic starter", timestamp: 1_000 },
        { messageId: "2", sender: "Bot", body: firstChunk, timestamp: 2_600 },
        { messageId: "3", sender: "Bot", body: secondChunk, timestamp: 2_700 },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual(["retained topic starter"]);
  });

  it("keeps a short cached turn whose words occur inside a discarded paragraph", async () => {
    readRecent.mockResolvedValue([
      { id: "u3", role: "user", text: "sounds good", timestamp: 3_000 },
    ]);
    readDiscardedBranch.mockResolvedValue({
      discarded: [
        {
          id: "a2",
          role: "assistant",
          text: "If that plan sounds good to you I will start the rollout tomorrow morning.",
          timestamp: 2_000,
        },
      ],
      retained: [{ id: "u3", role: "user", text: "sounds good", timestamp: 3_000 }],
    });
    const ctx = context({
      InboundHistory: [{ messageId: "9", sender: "User", body: "sounds good", timestamp: 3_000 }],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual(["sounds good"]);
  });

  it("drops a discarded reply whose cached copy lost its inline directive tags", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 },
    ]);
    readDiscardedBranch.mockResolvedValue({
      discarded: [
        {
          id: "a2",
          role: "assistant",
          text: "[[reply_to_current]]discarded answer",
          timestamp: 2_500,
        },
      ],
      retained: [{ id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 }],
    });
    const ctx = context({
      InboundHistory: [
        { messageId: "1", sender: "User", body: "retained topic starter", timestamp: 1_000 },
        { messageId: "3", sender: "Bot", body: "discarded answer", timestamp: 2_600 },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual(["retained topic starter"]);
  });

  it("keeps cached text that also survives on the active branch", async () => {
    readRecent.mockResolvedValue([{ id: "u3", role: "user", text: "ok", timestamp: 3_000 }]);
    readDiscardedBranch.mockResolvedValue({
      discarded: [{ id: "u2", role: "user", text: "ok", timestamp: 2_000 }],
      retained: [{ id: "u3", role: "user", text: "ok", timestamp: 3_000 }],
    });
    const ctx = context({
      InboundHistory: [{ messageId: "9", sender: "User", body: "ok", timestamp: 3_000 }],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual(["ok"]);
  });

  it("keeps cached history when the active path was too large to scan", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "retained topic starter", timestamp: 1_000 },
    ]);
    readDiscardedBranch.mockResolvedValue({
      discarded: [{ id: "u2", role: "user", text: "discarded question", timestamp: 2_000 }],
    });
    const ctx = context({
      InboundHistory: [
        { messageId: "2", sender: "User", body: "discarded question", timestamp: 2_100 },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "retained topic starter",
      "discarded question",
    ]);
  });

  it("fails closed for an unscoped session key without a routed agent owner", async () => {
    const ctx = context({ AgentId: undefined, SessionKey: "slack:channel:c1" });

    await expect(
      mergeSessionTranscriptContext({
        ctx,
        sessionKey: ctx.SessionKey!,
        storePath: "/tmp/sessions.json",
      }),
    ).rejects.toThrow("Session transcript context requires an agent owner.");
    expect(readRecent).not.toHaveBeenCalled();
  });

  it("skips canonical history for session-boundary commands", async () => {
    const ctx = context({ CommandBody: "/new summarize this workspace" });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(readRecent).not.toHaveBeenCalled();
    expect(ctx.InboundHistory).toBeUndefined();
  });
});
