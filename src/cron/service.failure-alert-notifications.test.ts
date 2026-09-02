import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-failure-notification-" });

describe("cron failure notification session handoff", () => {
  it.each(["now", "next-heartbeat"] as const)(
    "preserves the explicit origin and thread with wakeMode=%s",
    async (wakeMode) => {
      const store = await makeStorePath();
      const sessionKey = "agent:ops:telegram:group:42:topic:77";
      const deliveryContext = {
        channel: "telegram",
        to: "-10042",
        accountId: "work",
        threadId: "77",
      };
      const enqueueSessionEvent = vi.fn();
      const sendCronFailureAlert = vi.fn(async () => {
        throw new Error("transport unavailable");
      });
      const cron = new CronService({
        storePath: store.storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: logger,
        cronConfig: { failureAlert: { enabled: true, after: 1 } },
        resolveOriginDeliveryContext: () => deliveryContext,
        enqueueSystemEvent: vi.fn(),
        enqueueSessionEvent,
        sendCronFailureAlert,
        runSessionEvent: vi.fn(async () => ({
          status: "error" as const,
          error: "provider failed",
        })),
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "error" as const,
          error: "provider failed",
        })),
      });
      try {
        await cron.start();
        const job = await cron.add({
          name: "Important report",
          agentId: "ops",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: `session:${sessionKey}`,
          sessionKey: "agent:ops:discord:unrelated",
          wakeMode,
          payload: { kind: "agentTurn", message: "check" },
        });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
        expect(enqueueSessionEvent).toHaveBeenCalledWith(
          expect.stringContaining('Automation "Important report" failed'),
          expect.objectContaining({ agentId: "ops", sessionKey, deliveryContext }),
        );
        expect(cron.getJob(job.id)?.state.lastStatus).toBe("error");
      } finally {
        cron.stop();
      }
    },
  );
});
