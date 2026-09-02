import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAdmittedCronCompletionStatus } from "./completion-status.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { runCronSessionTurn } from "./session-run.js";

const fixture = vi.hoisted(() => ({
  enqueue: vi.fn(),
  delivery: vi.fn(),
  start: vi.fn(),
  config: {},
}));
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: (_agent: string, sessionKey: string) => ({
    sessionId: "session",
    sessionKey,
    generation: "generation",
    deliveryContext: { channel: "telegram", to: "old-group" },
  }),
  enqueueSessionEventForHost: fixture.enqueue,
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => fixture.config }));
vi.mock("./isolated-agent/run-delivery-trace.js", () => ({
  resolveCronDeliveryContext: fixture.delivery,
  buildCronDeliveryTrace: (input: unknown) => input,
}));
vi.mock("./scratch-store.js", () => ({ readCronJobScratchState: () => ({}) }));
vi.mock("./store.js", () => ({ resolveCronJobsStorePathFromConfig: () => "/unused" }));
vi.mock("../infra/system-events.js", () => ({
  prepareAutomationSystemEvents: () => ({ events: [], start: fixture.start }),
}));
vi.mock("../infra/heartbeat-compat.js", () => ({
  applyLegacyHeartbeatPromptContribution: ({ prompt }: { prompt: string }) => prompt,
}));

beforeEach(() => {
  fixture.enqueue.mockReset().mockReturnValue({
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  });
  fixture.delivery.mockReset();
  fixture.start.mockReset();
});

const params = () => ({
  cfg: fixture.config,
  agentId: "main",
  sessionKey: "agent:main:main",
  text: "check",
  assertCurrent: vi.fn(),
  job: makeCronJob({
    sessionTarget: "session:agent:main:main",
    delivery: { mode: "announce", target: "owner" },
  }),
});

describe("scheduled session execution", () => {
  it("does not inherit a group when owner delivery fails resolution", async () => {
    fixture.delivery.mockResolvedValue({
      deliveryRequested: true,
      deliveryPlan: { mode: "announce" },
      resolvedDelivery: { ok: false, error: new Error("no owner DM") },
    });
    const result = await runCronSessionTurn(params());
    expect(result).toMatchObject({ status: "ok", delivered: false, deliveryError: "no owner DM" });
    expect(fixture.enqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deliver: false, deliveryContext: undefined }),
    );
  });

  it("rechecks current delivery policy before the adapter handoff", async () => {
    fixture.delivery
      .mockResolvedValueOnce({
        deliveryRequested: true,
        deliveryPlan: { mode: "announce" },
        resolvedDelivery: {
          ok: true,
          channel: "telegram",
          to: "owner",
          accountId: "work",
          threadId: "7",
        },
      })
      .mockResolvedValueOnce({
        deliveryRequested: false,
        deliveryPlan: { mode: "none" },
        resolvedDelivery: { ok: false },
      });
    await runCronSessionTurn(params());
    const options = fixture.enqueue.mock.calls[0]![1];
    expect(options.deliveryContext).toMatchObject({
      to: "owner",
      accountId: "work",
      threadId: "7",
    });
    await expect(options.scheduledAutomation.beforeDeliver()).rejects.toThrow(
      "policy or owner route changed",
    );
  });

  it("does not mark required delivery complete after an identityless send", async () => {
    fixture.delivery.mockResolvedValue({
      deliveryRequested: true,
      deliveryPlan: { mode: "announce" },
      resolvedDelivery: { ok: true, channel: "telegram", to: "owner" },
    });
    fixture.enqueue.mockReturnValue({
      settled: Promise.resolve({
        status: "completed",
        executionStarted: true,
        delivered: true,
        deliveryAttempted: true,
        deliveryAmbiguous: true,
      }),
    });
    const input = params();
    const result = await runCronSessionTurn(input);
    expect(result.delivered).toBeUndefined();
    expect(result).toMatchObject({
      status: "ok",
      deliveryAttempted: true,
      deliveryState: { status: "unknown" },
    });
    expect(
      resolveAdmittedCronCompletionStatus(input.job, result.status, result.deliveryState!.status),
    ).toBe("unknown");
  });

  it("leaves deferred notices pending until actual execution", async () => {
    fixture.delivery.mockResolvedValue({
      deliveryRequested: false,
      deliveryPlan: { mode: "none" },
      resolvedDelivery: { ok: false },
    });
    await runCronSessionTurn(params());
    expect(fixture.start).not.toHaveBeenCalled();
    fixture.enqueue.mock.calls[0]![1].scheduledAutomation.onStarted();
    expect(fixture.start).toHaveBeenCalledOnce();
  });
});
