// Session-state notice context key decoding: strict UTF-8 after hex validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "../auto-reply/reply/session-event-handoff.js";
import {
  drainSystemEventEntries,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  decodeSessionStateNoticeContextKey,
  enqueueSessionStateNotice,
} from "./session-state-notices.js";

vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: vi.fn(() => ({
    sessionId: "original",
    generation: "process",
    agentId: "main",
    sessionKey: "agent:main:main",
  })),
  enqueueSessionEventForHost: vi.fn(() => ({
    id: "occurrence",
    cancel: vi.fn(),
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  })),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(enqueueSessionEvent).mockClear();
  vi.mocked(captureSessionEventTarget).mockClear();
  resetSystemEventsForTest();
});
afterEach(async () => {
  resetSystemEventsForTest();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

function encodeTarget(sessionKey: string): string {
  return `session-state:${Buffer.from(sessionKey, "utf8").toString("hex")}`;
}

describe("decodeSessionStateNoticeContextKey", () => {
  it("round-trips a valid encoded session key", () => {
    const sessionKey = "agent:main:slack:channel:C01234567";
    expect(decodeSessionStateNoticeContextKey(encodeTarget(sessionKey))).toBe(sessionKey);
  });

  it("round-trips a session key with a leading U+FEFF unchanged", () => {
    const sessionKey = "﻿agent:main";
    expect(decodeSessionStateNoticeContextKey(encodeTarget(sessionKey))).toBe(sessionKey);
  });

  it("rejects a context key whose hex payload is not valid UTF-8", () => {
    // 0xFF is not valid UTF-8; a forgiving decode would return U+FFFD and let a
    // corrupt context key collide with an unrelated watcher cursor.
    expect(decodeSessionStateNoticeContextKey("session-state:ff")).toBeUndefined();
  });

  it("rejects malformed prefixes and hex payloads", () => {
    expect(decodeSessionStateNoticeContextKey("other:ff")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:abc")).toBeUndefined();
    expect(decodeSessionStateNoticeContextKey("session-state:zz")).toBeUndefined();
  });
});

describe("enqueueSessionStateNotice", () => {
  const notice = {
    watcherSessionKey: "agent:main:main",
    targetSessionKey: "agent:main:slack:channel:C01234567",
    lastSeenSequence: 42,
  };
  it("coalesces repeated changes for 20 seconds and transfers the original occurrence", async () => {
    enqueueSessionStateNotice(notice);
    enqueueSessionStateNotice(notice);
    const [occurrence] = peekSystemEventEntries(notice.watcherSessionKey);
    if (!occurrence) {
      throw new Error("Expected queued notice");
    }
    await vi.advanceTimersByTimeAsync(19_999);
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
      occurrence.text,
      expect.objectContaining({
        agentId: "main",
        sessionKey: notice.watcherSessionKey,
        source: "session",
        occurrence,
        expectedTarget: expect.objectContaining({ sessionId: "original" }),
      }),
    );
  });
  it("does not revive a notice polled before its debounce expires", async () => {
    enqueueSessionStateNotice(notice);
    expect(drainSystemEventEntries(notice.watcherSessionKey)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });
  it("keeps group notices queue-only and replaces their watermark without duplicating context", async () => {
    enqueueSessionStateNotice({ ...notice, queueOnly: true });
    enqueueSessionStateNotice({ ...notice, queueOnly: true, lastSeenSequence: 43 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(captureSessionEventTarget).not.toHaveBeenCalled();
    const pending = peekSystemEventEntries(notice.watcherSessionKey);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toContain("changesSince 43");
  });
});
