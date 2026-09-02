import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  type ReplyOperation,
} from "../auto-reply/reply/reply-run-registry.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { isCronExecutionIdle } from "./execution-idle.js";

const embedded = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("../agents/embedded-agent-runner/active-run-projections.js", () => ({
  listActiveEmbeddedRunSessionKeys: () => embedded.keys,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ loadSessionEntry: () => undefined }));

const operations: ReplyOperation[] = [];
afterEach(() => {
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
  embedded.keys = [];
});
const job = makeCronJob({ agentId: "main", idleOnly: true, sessionTarget: "isolated" });

describe("idle-only execution admission", () => {
  it("observes foreground admission before backend registration, including another conversation", () => {
    expect(isCronExecutionIdle({}, job, "main")).toBe(true);
    operations.push(
      createReplyOperation({
        sessionKey: "agent:main:chat:foreground",
        sessionId: "foreground",
        resetTriggered: false,
        turnKind: "visible",
      }),
    );
    expect(isCronExecutionIdle({}, job, "main")).toBe(false);
    expect(operations[0]!.abortSignal.aborted).toBe(false);
  });

  it("excludes only its own backend at the runner-entry recheck", () => {
    const ownSessionKey = "agent:main:cron:check:run:one";
    embedded.keys = [ownSessionKey, "agent:other:main"];
    expect(isCronExecutionIdle({}, job, "main", ownSessionKey)).toBe(true);
    embedded.keys.push("agent:main:chat:foreground");
    expect(isCronExecutionIdle({}, job, "main", ownSessionKey)).toBe(false);
  });
});
