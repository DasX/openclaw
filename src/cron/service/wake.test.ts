import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCronServiceState } from "./state.js";
import { wake } from "./wake.js";

function setup() {
  const enqueueSessionEvent = vi.fn();
  const deferSessionEvent = vi.fn();
  const state = createCronServiceState({
    cronEnabled: true,
    storePath: "/unused/wake",
    defaultAgentId: "main",
    resolveSessionEventTarget: (opts) => ({
      agentId: opts?.agentId ?? "main",
      sessionKey: opts?.sessionKey ?? `agent:${opts?.agentId ?? "main"}:main`,
    }),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent,
    deferSessionEvent,
    runIsolatedAgentJob: vi.fn(),
  });
  state.store = { version: 1, jobs: [] };
  return { state, enqueueSessionEvent, deferSessionEvent };
}

describe("v4 wake adapter", () => {
  it("runs an immediate follow-up without a monitor or enabled cron", () => {
    const { state, enqueueSessionEvent } = setup();
    state.deps.cronEnabled = false;
    expect(wake(state, { mode: "now", text: "completion" })).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledWith("completion", undefined);
  });

  it("retains the explicit-session immediate exception and original delivery route", () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = setup();
    const deliveryContext = { channel: "telegram", to: "42", accountId: "work", threadId: "7" };
    state.deps.resolveOriginDeliveryContext = () => deliveryContext;
    expect(
      wake(state, {
        mode: "next-heartbeat",
        text: "completion",
        agentId: "main",
        sessionKey: "agent:main:telegram:42",
      }),
    ).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledWith("completion", {
      agentId: "main",
      sessionKey: "agent:main:telegram:42",
      deliveryContext,
    });
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "disabled",
    "isolated",
    "wrong-owner",
    "wrong-session",
    "unscheduled",
    "cron-disabled",
  ])("refuses %s deferred targets before enqueue", (reason) => {
    const { state, enqueueSessionEvent, deferSessionEvent } = setup();
    const job = makeCronJob({
      agentId: "main",
      sessionTarget: "session:agent:main:main",
      state: { nextRunAtMs: Date.now() + 60_000 },
    });
    if (reason !== "missing") {
      state.store!.jobs = [job];
    }
    if (reason === "disabled") {
      job.enabled = false;
    }
    if (reason === "isolated") {
      job.sessionTarget = "isolated";
    }
    if (reason === "wrong-owner") {
      job.agentId = "other";
    }
    if (reason === "wrong-session") {
      job.sessionTarget = "session:agent:main:unrelated";
    }
    if (reason === "unscheduled") {
      job.state.nextRunAtMs = undefined;
    }
    if (reason === "cron-disabled") {
      state.deps.cronEnabled = false;
    }
    expect(wake(state, { mode: "next-heartbeat", text: "notice" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("mode now"),
    });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
    expect(deferSessionEvent).not.toHaveBeenCalled();
  });

  it("attaches deferred work to one ordinary scheduled job", () => {
    const { state, enqueueSessionEvent, deferSessionEvent } = setup();
    const job = makeCronJob({
      agentId: "main",
      sessionTarget: "session:agent:main:main",
      state: { nextRunAtMs: Date.now() + 60_000 },
    });
    state.store!.jobs = [job];
    expect(wake(state, { mode: "next-heartbeat", text: "notice" })).toEqual({ ok: true });
    expect(deferSessionEvent).toHaveBeenCalledWith("notice", job, undefined);
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });

  it("rejects blank text and subagent targets without enqueue", () => {
    const { state, enqueueSessionEvent } = setup();
    expect(wake(state, { mode: "now", text: " " }).ok).toBe(false);
    expect(
      wake(state, { mode: "now", text: "x", sessionKey: "agent:main:subagent:worker" }),
    ).toMatchObject({ ok: false });
    expect(enqueueSessionEvent).not.toHaveBeenCalled();
  });
});
