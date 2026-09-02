import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

describe("cron script session follow-up", () => {
  it.each(["now", "next-heartbeat"] as const)(
    "hands explicit-session %s work directly to session admission with cron disabled",
    async (wake) => {
      const enqueueSessionEvent = vi.fn();
      const target = {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        sessionId: "original",
        lifecycleRevision: "r1",
        generation: "g1",
      };
      const capture = vi.fn(() => target);
      const state = createCronServiceState({
        storePath: "/unused",
        cronEnabled: false,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        enqueueSessionEvent,
        captureSessionEventTarget: capture,
        runIsolatedAgentJob: vi.fn(),
        runScriptJob: vi.fn(async () => {
          expect(capture).toHaveBeenCalledOnce();
          capture.mockReturnValue({ ...target, sessionId: "replacement", lifecycleRevision: "r2" });
          return { status: "ok" as const, notify: "Check the finished deployment", wake };
        }),
      });
      const job = makeCronJob({
        id: "script",
        agentId: "ops",
        sessionKey: "agent:ops:main",
        sessionTarget: "main",
        payload: { kind: "script", script: "return { wake: 'now' }" },
      });
      await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
      expect(enqueueSessionEvent).toHaveBeenCalledWith(
        "Check the finished deployment",
        expect.objectContaining({
          agentId: "ops",
          sessionKey: "agent:ops:main",
          expectedTarget: target,
        }),
      );
      expect(state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );
});
