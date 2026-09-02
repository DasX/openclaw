import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";

const enqueueSystemEventMock = vi.fn();
const enqueueSessionEventMock = vi.fn();
const captureSessionEventTargetMock = vi.fn(() => ({
  sessionId: "original-main",
  generation: "original-generation",
}));
const runCronIsolatedAgentTurnMock = vi.fn();
const loadConfigMock = vi.fn<() => OpenClawConfig>();
const logHooksWarnMock = vi.fn();

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  enqueueSessionEventForHost: enqueueSessionEventMock,
  captureSessionEventTargetForHost: captureSessionEventTargetMock,
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));
vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

let capturedDispatchAgentHook: ((value: HookPayload) => Promise<unknown>) | undefined;

vi.mock("./hooks-request-handler.js", () => ({
  createHooksRequestHandler: vi.fn((opts: Record<string, unknown>) => {
    capturedDispatchAgentHook = opts.dispatchAgentHook as typeof capturedDispatchAgentHook;
    return vi.fn();
  }),
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");

type HookPayload = {
  message: string;
  name: string;
  agentId?: string;
  effectiveAgentId: string;
  wakeMode: "now" | "next-heartbeat";
  sessionKey: string;
  sourcePath: string;
  deliver: boolean;
  channel: "last";
  delivery: { mode: "none" };
};

function payload(overrides: Partial<HookPayload> = {}): HookPayload {
  return {
    message: "test message",
    name: "Email",
    effectiveAgentId: "main",
    wakeMode: "now",
    sessionKey: "session-1",
    sourcePath: "/hooks/agent",
    deliver: true,
    channel: "last",
    delivery: { mode: "none" },
    ...overrides,
  };
}

function globalConfig(defaultAgentId: "main" | "work", includeMain = true): OpenClawConfig {
  return {
    agents: {
      entries: {
        ...(includeMain ? { main: { default: defaultAgentId === "main" } } : {}),
        work: { default: defaultAgentId === "work" },
      },
    },
    session: { scope: "global" },
  };
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function dispatch(value: HookPayload): Promise<unknown> {
  if (!capturedDispatchAgentHook) {
    throw new Error("dispatchAgentHook missing");
  }
  return capturedDispatchAgentHook(value);
}

function expectOwnedEvent(text: string, agentId: string): void {
  const call = enqueueSessionEventMock.mock.calls.find(([actual]) => actual === text);
  expect(call?.[1]).toMatchObject({
    sessionKey: "global",
    agentId,
    expectedTarget: { sessionId: "original-main", generation: "original-generation" },
  });
}

async function startGatedRun(
  result: "success" | "failure",
  wakeMode: "now" | "next-heartbeat" = "now",
) {
  const gate = createDeferred();
  runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
    await gate.promise;
    if (result === "failure") {
      throw new Error("agent exploded");
    }
    return { status: "ok", summary: "done", delivered: false, deliveryAttempted: false };
  });
  void dispatch(payload({ wakeMode }));
  await vi.waitFor(() => expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(1));
  return gate;
}

describe("global hook terminal target resolution", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    vi.clearAllMocks();
    captureSessionEventTargetMock.mockReturnValue({
      sessionId: "original-main",
      generation: "original-generation",
    });
    enqueueSessionEventMock.mockReturnValue({
      id: "terminal",
      cancel: vi.fn(),
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
    });
    loadConfigMock.mockReturnValue(globalConfig("main"));
    capturedDispatchAgentHook = undefined;
    createGatewayHooksRequestHandler({
      deps: {} as never,
      getHooksConfig: () => null,
      getClientIpConfig: () => ({ trustedProxies: undefined, allowRealIpFallback: false }),
      bindHost: "127.0.0.1",
      port: 18789,
      logHooks: {
        warn: logHooksWarnMock,
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      } as never,
    });
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    vi.restoreAllMocks();
  });

  it("keeps the accepted agent when hooks are disabled and the default changes", async () => {
    const gate = await startGatedRun("success");
    loadConfigMock.mockReturnValue({
      ...globalConfig("work"),
      hooks: { enabled: false },
    });
    gate.resolve();

    await vi.waitFor(() => expectOwnedEvent("Hook Email: done", "main"));
    expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
  });

  it("keeps the target captured before the hook runner waits", async () => {
    const gate = await startGatedRun("success");
    expect(captureSessionEventTargetMock).toHaveBeenCalledExactlyOnceWith("main", "global");
    captureSessionEventTargetMock.mockReturnValue({
      sessionId: "successor-main",
      generation: "successor-generation",
    });
    gate.resolve();
    await vi.waitFor(() => expectOwnedEvent("Hook Email: done", "main"));
    expect(captureSessionEventTargetMock).toHaveBeenCalledTimes(1);
  });

  it("records a rejected terminal follow-up without claiming delivery", async () => {
    const gate = await startGatedRun("success");
    enqueueSessionEventMock.mockReturnValueOnce({
      id: "terminal",
      cancel: vi.fn(),
      settled: Promise.resolve({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: "session replaced",
      }),
    });
    gate.resolve();
    await vi.waitFor(() =>
      expect(logHooksWarnMock).toHaveBeenCalledWith(
        "hook terminal follow-up failed",
        expect.objectContaining({ error: "session replaced", executionStarted: false }),
      ),
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the accepted agent is removed after success",
      outcome: "success" as const,
      wakeMode: "now" as const,
      status: "ok",
      reason: "accepted-agent-removed",
    },
    {
      name: "the accepted agent is removed after failure",
      outcome: "failure" as const,
      wakeMode: "now" as const,
      status: "error",
      reason: "accepted-agent-removed",
    },
    {
      name: "the accepted agent is removed before next-heartbeat completion",
      outcome: "success" as const,
      wakeMode: "next-heartbeat" as const,
      status: "ok",
      reason: "accepted-agent-removed",
    },
  ])("suppresses the terminal event when $name", async (testCase) => {
    const gate = await startGatedRun(testCase.outcome, testCase.wakeMode);
    loadConfigMock.mockReturnValue({
      ...globalConfig("work", false),
      hooks: { enabled: true, token: "test-token", allowedAgentIds: ["*"] },
    });
    gate.resolve();

    await vi.waitFor(() =>
      expect(logHooksWarnMock).toHaveBeenCalledWith(
        "hook agent terminal event suppressed",
        expect.objectContaining({
          acceptedAgentId: "main",
          status: testCase.status,
          reason: testCase.reason,
          runId: expect.any(String),
          jobId: expect.any(String),
        }),
      ),
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
  });
});
