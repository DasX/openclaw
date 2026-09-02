import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { drainSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  getGatewaySuspendAdmissionPhase,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/types.js";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "./session-event-handoff.js";

const fixture = vi.hoisted(() => ({
  entry: { sessionId: "s1", lifecycleRevision: "r1", deliveryContext: { channel: "webchat" } } as
    | Record<string, unknown>
    | undefined,
  generation: "g1",
  operation: undefined as { sessionId: string; abortSignal: AbortSignal } | undefined,
  dispatch: vi.fn(),
  route: vi.fn(),
  append: vi.fn(),
}));
vi.mock("../../config/runtime-snapshot.js", () => ({ getRuntimeConfigSnapshot: () => ({}) }));
vi.mock("../../agents/agent-scope-config.js", () => ({
  resolveConfiguredAgentId: (_: unknown, id: string) => id,
}));
vi.mock("../../agents/agent-lifecycle-registry.js", () => ({
  isAgentDeletionBlocked: () => false,
}));
vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/test/sessions",
}));
vi.mock("../../config/sessions/session-accessor.read.js", () => ({
  loadExactSessionEntryReadOnly: () =>
    fixture.entry ? { sessionKey: "agent:main:main", entry: fixture.entry } : undefined,
}));
vi.mock("../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => fixture.generation,
  assertAgentRunLifecycleGenerationCurrent: (generation: string) => {
    if (generation !== fixture.generation) {
      throw new Error("Gateway restarted");
    }
  },
}));
vi.mock("../../sessions/runtime-context.js", () => ({
  appendSessionRuntimeContext: fixture.append,
}));
vi.mock("./reply-run-registry.js", () => ({ replyRunRegistry: { get: () => fixture.operation } }));
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: fixture.dispatch,
}));
vi.mock("./route-reply.js", () => ({ isRoutableChannel: () => true, routeReply: fixture.route }));

type Dispatch = {
  replyOptions: InternalGetReplyOptions;
  dispatcherOptions: {
    deliver: (payload: { text: string }, info: { kind: "final" }) => Promise<void>;
  };
};
const key = "agent:main:main";
function adopt(options: InternalGetReplyOptions) {
  fixture.operation = {
    sessionId: String(fixture.entry?.sessionId),
    abortSignal: new AbortController().signal,
  };
  return options.turnAdoptionLifecycle!.onAdopted();
}
async function run(dispatch: Dispatch) {
  await adopt(dispatch.replyOptions);
  await dispatch.replyOptions.internalEventExecution!.beforeStart?.();
  dispatch.replyOptions.internalEventExecution!.onStarted("run-1");
  await dispatch.replyOptions.internalEventExecution!.onTerminal("run-1", "completed");
}

beforeEach(() => {
  resetSystemEventsForTest();
  resetGatewayWorkAdmission();
  fixture.entry = {
    sessionId: "s1",
    lifecycleRevision: "r1",
    deliveryContext: { channel: "webchat" },
  };
  fixture.generation = "g1";
  fixture.operation = undefined;
  fixture.dispatch.mockReset();
  fixture.route.mockReset().mockResolvedValue({ ok: true, delivered: true });
  fixture.append.mockReset();
});

afterEach(async () => {
  resetSystemEventsForTest();
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  resetGatewayWorkAdmission();
});

describe("producer-owned session events", () => {
  it("cancels the independent admission wait without waiting for host resume", async () => {
    // Observe the real helper's returned promise; do not replace its admission policy.
    const continuation = vi.spyOn(
      await import("../../process/gateway-work-admission.js"),
      "runWithGatewayIndependentRootWorkContinuation",
    );
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);
    const pending: Promise<unknown>[] = [];
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const receipt = enqueueSessionEvent("parked completion", {
          agentId: "main",
          sessionKey: key,
          source: "exec",
        });
        const observed = continuation.mock.results.at(-1)!.value as Promise<unknown>;
        const rejected = vi.fn();
        const work = observed.catch(rejected);
        pending.push(work);
        receipt.cancel();
        await expect(receipt.settled).resolves.toMatchObject({
          status: "cancelled",
          executionStarted: false,
        });
        await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
        await work;
        const signal = continuation.mock.calls.at(-1)![2]!;
        expect(getEventListeners(signal, "abort")).toHaveLength(0);
        expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(drainSystemEvents(key)).toEqual([]);
      }
    } finally {
      resetGatewayWorkAdmission();
      await Promise.allSettled(pending);
      continuation.mockRestore();
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("settles an outer restart rejection without dispatching or leaving an occurrence", async () => {
    markGatewayRestartDraining();
    const receipt = enqueueSessionEvent("completion", {
      agentId: "main",
      sessionKey: key,
      source: "exec",
    });
    await expect(receipt.settled).resolves.toMatchObject({
      status: "failed",
      executionStarted: false,
      error: expect.stringContaining("GatewayDrainingError"),
    });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(drainSystemEvents(key)).toEqual([]);
  });

  it.each(["drain", "signal"] as const)(
    "keeps real session admission fenced for a live-parent %s",
    async (close) => {
      const root = tryBeginGatewayRootWorkAdmission("ws:agent");
      fixture.dispatch.mockImplementation(async () => {
        // Exercise the real subordinate guard, not a mock of the admission error.
        await beginSessionWorkAdmission({
          scope: "/test/sessions",
          identities: [key],
          assertAllowed: () => {},
        });
        throw new Error("restart admitted model work");
      });
      try {
        const receipt = await root!.run(async () => {
          if (close === "drain") {
            markGatewayRestartDraining();
          } else {
            beginGatewayRestartSignalAdmission();
          }
          return enqueueSessionEvent("completion", {
            agentId: "main",
            sessionKey: key,
            source: "exec",
          });
        });
        root!.release();
        await expect(receipt.settled).resolves.toMatchObject({
          status: "failed",
          executionStarted: false,
          error: expect.stringContaining("GatewayDrainingError"),
        });
        expect(fixture.dispatch).toHaveBeenCalledOnce();
      } finally {
        root?.release();
      }
    },
  );

  it.each(["resume", "cancel", "reset", "delete", "permission", "gateway", "plugin"] as const)(
    "revalidates an independent occurrence after suspension: %s",
    async (change) => {
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      let pluginActive = true;
      fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
        await run(dispatch);
        return {};
      });
      const receipt = enqueueSessionEvent("parked completion", {
        agentId: "main",
        sessionKey: key,
        source: "plugin",
        assertCurrent: () => {
          if (!pluginActive) {
            throw new Error("plugin retired");
          }
        },
      });
      try {
        await Promise.resolve();
        expect(fixture.dispatch).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        if (change === "cancel") {
          expect(receipt.cancel()).toBe(true);
          await expect(receipt.settled).resolves.toMatchObject({
            status: "cancelled",
            executionStarted: false,
          });
        } else if (change === "reset") {
          fixture.entry = { ...fixture.entry, lifecycleRevision: "r2" };
        } else if (change === "delete") {
          fixture.entry = undefined;
        } else if (change === "permission") {
          fixture.entry!.permissionMode = "read-only";
        } else if (change === "gateway") {
          fixture.generation = "g2";
        } else if (change === "plugin") {
          pluginActive = false;
        }
        expect(suspension?.release()).toBe(true);
        await expect(receipt.settled).resolves.toMatchObject({
          status: change === "resume" ? "completed" : change === "cancel" ? "cancelled" : "failed",
          executionStarted: change === "resume",
        });
        expect(fixture.dispatch).toHaveBeenCalledTimes(change === "resume" ? 1 : 0);
      } finally {
        suspension?.release();
        receipt.cancel();
      }
    },
  );

  it("reserves a distinct live-parent root across suspension until delivery settles", async () => {
    const root = tryBeginGatewayRootWorkAdmission("ws:agent");
    const delivery = createDeferredCore();
    const release = createDeferredCore();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      await run(dispatch);
      delivery.resolve();
      await release.promise;
      return {};
    });
    try {
      const receipt = await root!.run(async () => {
        const pending = enqueueSessionEvent("completion", {
          agentId: "main",
          sessionKey: key,
          source: "exec",
        });
        expect(getActiveGatewayRootWorkCount()).toBe(2);
        return pending;
      });
      root!.release();
      await delivery.promise;
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      release.resolve();
      await receipt.settled;
    } finally {
      release.resolve();
      root?.release();
      suspension?.rollback();
    }
  });
  it("waits for the adopted owner on cancellation before model start", async () => {
    const adopted = createDeferredCore();
    const release = createDeferredCore();
    fixture.dispatch.mockImplementation(async ({ replyOptions }: Dispatch) => {
      await adopt(replyOptions);
      adopted.resolve();
      await release.promise;
      return {};
    });
    const receipt = enqueueSessionEvent("queued", {
      agentId: "main",
      sessionKey: key,
      source: "exec",
    });
    await adopted.promise;
    let settled = false;
    void receipt.settled.then(() => {
      settled = true;
    });
    receipt.cancel();
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await expect(receipt.settled).resolves.toMatchObject({
      status: "cancelled",
      executionStarted: false,
    });
  });

  it("commits the durable attempt at adoption, never while merely queued", async () => {
    let queued!: Dispatch;
    const committed = createDeferredCore();
    const onAdopted = vi.fn(() => committed.promise);
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      queued = dispatch;
      dispatch.replyOptions.turnAdoptionLifecycle!.onDeferred?.();
      return { deferredToActiveRun: true };
    });
    const receipt = enqueueSessionEvent("restart", {
      agentId: "main",
      sessionKey: key,
      source: "restart",
      onAdopted,
    });
    await vi.waitFor(() => expect(queued).toBeDefined());
    expect(onAdopted).not.toHaveBeenCalled();
    let adopted = false;
    const adoption = Promise.resolve(adopt(queued.replyOptions)).then(() => {
      adopted = true;
    });
    expect(onAdopted).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(adopted).toBe(false);
    committed.resolve();
    await adoption;
    receipt.cancel();
    queued.replyOptions.turnAdoptionLifecycle!.onSettled?.();
    await receipt.settled;
    await expect(adopt(queued.replyOptions)).rejects.toThrow("settled");
    expect(onAdopted).toHaveBeenCalledOnce();
  });

  it.each(["failure", "cancellation"] as const)(
    "releases the queued root after in-flight adoption %s settles",
    async (outcome) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let queued!: Dispatch;
      fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
        queued = dispatch;
        dispatch.replyOptions.turnAdoptionLifecycle!.onDeferred?.();
        return { deferredToActiveRun: true };
      });
      const receipt = enqueueSessionEvent("queued", {
        agentId: "main",
        sessionKey: key,
        source: "exec",
        onAdopted: async () => {
          entered.resolve();
          await release.promise;
          throw new Error("adoption failed");
        },
      });
      await vi.waitFor(() => expect(queued).toBeDefined());
      fixture.operation = { sessionId: "s1", abortSignal: new AbortController().signal };
      const queuedRun = { turnAdoptionLifecycle: queued.replyOptions.turnAdoptionLifecycle };
      const adoption = admitFollowupRunLifecycle(queuedRun);
      const rejected = expect(adoption).rejects.toThrow("adoption failed");
      await entered.promise;
      if (outcome === "cancellation") {
        receipt.cancel();
      }
      completeFollowupRunLifecycle(queuedRun);
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      release.resolve();
      await rejected;
      await expect(receipt.settled).resolves.toMatchObject({
        status: outcome === "failure" ? "failed" : "cancelled",
        executionStarted: false,
      });
    },
  );

  it("keeps the producer tool ceiling when a scheduled job requests a wider surface", async () => {
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      expect(dispatch.replyOptions.toolsAllow).toEqual(["*"]);
      expect(readToolAllowlistIntersection(dispatch.replyOptions.toolsAllow!)).toEqual([["read"]]);
      await run(dispatch);
      return {};
    });
    const target = { ...captureSessionEventTarget("main", key), toolsAllow: ["read"] };
    const receipt = enqueueSessionEvent("check", {
      agentId: "main",
      sessionKey: key,
      source: "cron",
      expectedTarget: target,
      scheduledAutomation: {
        job: {
          id: "job",
          payload: { kind: "agentTurn", message: "check", toolsAllow: ["*"] },
        } as never,
        assertCurrent: () => {},
      },
    });
    await expect(receipt.settled).resolves.toMatchObject({ status: "completed" });
  });

  it("retains an unstarted occurrence when foreground activity wins after preparation", async () => {
    let mayStart = true;
    fixture.dispatch.mockImplementation(async ({ replyOptions }: Dispatch) => {
      await adopt(replyOptions);
      await replyOptions.internalEventExecution!.beforeStart?.();
      mayStart = false;
      replyOptions.internalEventExecution!.onStarted("late-start");
      return {};
    });
    const receipt = enqueueSessionEvent("check", {
      agentId: "main",
      sessionKey: key,
      source: "cron",
      scheduledAutomation: {
        job: {
          id: "job",
          idleOnly: true,
          payload: { kind: "agentTurn", message: "check" },
        } as never,
        assertCurrent: () => {},
        beforeStart: () => mayStart,
      },
    });
    await expect(receipt.settled).resolves.toMatchObject({
      admissionDeferred: true,
      executionStarted: false,
      delivered: false,
    });
  });

  it("settles internal work without claiming a transport send, and revokes retained callbacks", async () => {
    let retained!: Dispatch;
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      retained = dispatch;
      await run(dispatch);
      await dispatch.dispatcherOptions.deliver({ text: "finished" }, { kind: "final" });
      return {};
    });
    const receipt = enqueueSessionEvent("Check completion", {
      agentId: "main",
      sessionKey: key,
      source: "exec",
    });
    await expect(receipt.settled).resolves.toMatchObject({
      status: "completed",
      executionStarted: true,
      delivered: false,
      summary: "finished",
    });
    expect(fixture.route).not.toHaveBeenCalled();
    await expect(
      retained.dispatcherOptions.deliver({ text: "late" }, { kind: "final" }),
    ).rejects.toThrow("settled");
  });

  it("rejects completion from a producer admitted before reset", () => {
    const expectedTarget = captureSessionEventTarget("main", key);
    fixture.entry = { sessionId: "s2", lifecycleRevision: "r2" };
    expect(() =>
      enqueueSessionEvent("old completion", {
        agentId: "main",
        sessionKey: key,
        source: "exec",
        expectedTarget,
      }),
    ).toThrow("reset or replaced");
    expect(drainSystemEvents(key)).toEqual([]);
  });

  it("lets polling cancel exactly the queued occurrence before execution", async () => {
    let queued!: InternalGetReplyOptions;
    fixture.dispatch.mockImplementation(async ({ replyOptions }: Dispatch) => {
      queued = replyOptions;
      replyOptions.turnAdoptionLifecycle!.onDeferred?.();
      return { deferredToActiveRun: true };
    });
    const receipt = enqueueSessionEvent("queued completion", {
      agentId: "main",
      sessionKey: key,
      source: "exec",
    });
    await vi.waitFor(() => expect(queued).toBeDefined());
    expect(receipt.cancel()).toBe(true);
    await expect(receipt.settled).resolves.toMatchObject({
      status: "cancelled",
      executionStarted: false,
    });
    expect(() => queued.internalEventExecution!.onStarted("late")).toThrow();
    expect(fixture.route).not.toHaveBeenCalled();
  });

  it("retains the producer route while busy and releases cron capacity until adoption", async () => {
    let queued!: Dispatch;
    const capacity = { suspend: vi.fn(), resume: vi.fn().mockResolvedValue(undefined) };
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      queued = dispatch;
      dispatch.replyOptions.turnAdoptionLifecycle!.onDeferred?.();
      return { deferredToActiveRun: true };
    });
    const receipt = enqueueSessionEvent("run check", {
      agentId: "main",
      sessionKey: key,
      source: "cron",
      deliveryContext: { channel: "telegram", to: "owner", accountId: "work", threadId: "7" },
      scheduledAutomation: {
        job: { id: "job", payload: { kind: "agentTurn", message: "check" } } as never,
        assertCurrent: () => {},
        capacity,
      },
    });
    await vi.waitFor(() => expect(capacity.suspend).toHaveBeenCalledOnce());
    fixture.entry!.deliveryContext = { channel: "telegram", to: "unrelated-group" };
    await run(queued);
    await queued.replyOptions.onQueuedFollowupReplyBatch!({
      payloads: [{ text: "done" }],
    } as never);
    queued.replyOptions.turnAdoptionLifecycle!.onSettled?.();
    await expect(receipt.settled).resolves.toMatchObject({ status: "completed", delivered: true });
    expect(capacity.resume).toHaveBeenCalledOnce();
    expect(fixture.route).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner", accountId: "work", threadId: "7" }),
    );
  });

  it("preserves an identityless send as ambiguous without issuing another send", async () => {
    fixture.route.mockResolvedValue({ ok: true, delivered: true, ambiguous: true });
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      await run(dispatch);
      await dispatch.dispatcherOptions.deliver({ text: "finished" }, { kind: "final" });
      return {};
    });
    const receipt = enqueueSessionEvent("check", {
      agentId: "main",
      sessionKey: key,
      source: "cron",
      deliveryContext: { channel: "telegram", to: "owner" },
    });
    await expect(receipt.settled).resolves.toMatchObject({
      status: "completed",
      deliveryAttempted: true,
      deliveryAmbiguous: true,
    });
    expect(fixture.route).toHaveBeenCalledOnce();
  });

  it("does not use a matching persisted row after the operational owner closes", async () => {
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      await run(dispatch);
      fixture.operation = undefined;
      await dispatch.dispatcherOptions.deliver({ text: "must not send" }, { kind: "final" });
      return {};
    });
    const receipt = enqueueSessionEvent("check", {
      agentId: "main",
      sessionKey: key,
      source: "plugin",
      deliveryContext: { channel: "telegram", to: "owner" },
    });
    await expect(receipt.settled).resolves.toMatchObject({ status: "failed", delivered: false });
    expect(fixture.route).not.toHaveBeenCalled();
  });

  it.each(["restart", "reset", "permission"] as const)(
    "fences a queued event after %s",
    async (change) => {
      let queued!: Dispatch;
      fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
        queued = dispatch;
        dispatch.replyOptions.turnAdoptionLifecycle!.onDeferred?.();
        return { deferredToActiveRun: true };
      });
      const receipt = enqueueSessionEvent("check", {
        agentId: "main",
        sessionKey: key,
        source: "task",
      });
      await vi.waitFor(() => expect(queued).toBeDefined());
      if (change === "restart") {
        fixture.generation = "g2";
      }
      if (change === "reset") {
        fixture.entry = { sessionId: "s1", lifecycleRevision: "r2" };
      }
      if (change === "permission") {
        fixture.entry!.permissionMode = "read-only";
      }
      await expect(adopt(queued.replyOptions)).rejects.toThrow(
        change === "restart"
          ? "restarted"
          : change === "reset"
            ? "destination"
            : "permission ceiling",
      );
      receipt.cancel();
      queued.replyOptions.turnAdoptionLifecycle!.onSettled?.();
      await receipt.settled;
    },
  );

  it("allows first-session work through normal admission", async () => {
    fixture.entry = undefined;
    const expectedTarget = captureSessionEventTarget("main", key);
    fixture.dispatch.mockImplementation(async (dispatch: Dispatch) => {
      fixture.entry = { sessionId: "new", lifecycleRevision: "new" };
      await run(dispatch);
      return {};
    });
    const receipt = enqueueSessionEvent("fresh hook", {
      agentId: "main",
      sessionKey: key,
      source: "hook",
      expectedTarget,
    });
    await expect(receipt.settled).resolves.toMatchObject({
      status: "completed",
      executionStarted: true,
    });
  });
});
