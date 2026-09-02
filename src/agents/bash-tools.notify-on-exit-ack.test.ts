import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enqueueSessionEventForHost as enqueueSessionEvent } from "../auto-reply/reply/session-event-handoff.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { selectAgentSystemEvents } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { startDeferredNotifyRun } from "./bash-tools.notify-on-exit-ack.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";

const supervisorSpawnMock = vi.hoisted(() => vi.fn());
const randomMock = vi.hoisted(() => vi.fn(() => 0));

vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>();
  return { ...actual, enqueueSessionEventForHost: vi.fn(actual.enqueueSessionEventForHost) };
});
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn(async (params) => {
    params.replyOptions.turnAdoptionLifecycle.onDeferred();
    return { deferredToActiveRun: true };
  }),
}));
vi.mock("../infra/secure-random.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/secure-random.js")>()),
  generateSecureInt: randomMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorSpawnMock, getRecord: vi.fn() }),
}));

const QUEUE_KEY = "agent:main:notify-ack";
const startNotifyRun = () =>
  startDeferredNotifyRun({
    spawn: supervisorSpawnMock,
    sessionKey: QUEUE_KEY,
    notifyDeliveryContext: { channel: "telegram", to: "-100123", threadId: 42 },
  });
const processTool = createProcessTool();
const execute = (action: "poll" | "clear", sessionId: string) =>
  processTool.execute(`${action}-${sessionId}`, { action, sessionId });
const poll = (sessionId: string) => execute("poll", sessionId);
const contexts = () => peekSystemEventEntries(QUEUE_KEY).map((event) => event.contextKey);

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "exec-occurrence-" });
  setRuntimeConfigSnapshot({ agents: { entries: { main: { default: true }, research: {} } } });
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
});
afterEach(async () => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

it("keeps selected-agent global completions scoped to their owner", async () => {
  const process = await startDeferredNotifyRun({
    spawn: supervisorSpawnMock,
    sessionKey: "global",
    agentId: "research",
  });
  await process.finish();

  expect(enqueueSessionEvent).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      source: "exec",
      agentId: "research",
      sessionKey: "global",
      expectedTarget: expect.objectContaining({ agentId: "research", sessionKey: "global" }),
    }),
  );
  const queued = peekSystemEventEntries("global");
  expect(selectAgentSystemEvents(queued, "research")).toHaveLength(1);
  expect(selectAgentSystemEvents(queued, "main")).toEqual([]);
});

it("isolates identical completions across exact full-slug reuse", async () => {
  const first = await startNotifyRun();
  await first.finish();
  await execute("clear", first.run.session.id);
  enqueueSystemEventEntry("unrelated", { sessionKey: QUEUE_KEY, contextKey: "marker" });
  const second = await startNotifyRun();
  await second.finish();

  expect([first.run.session.id, second.run.session.id]).toEqual(["amber-atlas", "amber-atlas"]);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker", "exec:amber-atlas"]);
  const queued = peekSystemEventEntries(QUEUE_KEY);
  expect(queued[0]?.id).not.toBe(queued[2]?.id);
  expect(queued[0]).toEqual({ ...queued[2], id: queued[0]?.id });

  await poll(second.run.session.id);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
  await poll(second.run.session.id);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
});

it("invalidates an occurrence snapshot when terminal poll consumes its occurrence", async () => {
  const process = await startNotifyRun();
  await process.finish();
  const snapshot = peekSystemEventEntries(QUEUE_KEY);
  await poll(process.run.session.id);

  expect(peekSystemEventEntries(QUEUE_KEY)).toEqual([]);
  expect(consumeSelectedSystemEventEntries(QUEUE_KEY, snapshot)).toEqual([]);
});

it("keeps an identical successor queued when an earlier consumer settles", async () => {
  const first = await startNotifyRun();
  await first.finish();
  const snapshot = peekSystemEventEntries(QUEUE_KEY);
  const receipt = vi.mocked(enqueueSessionEvent).mock.results.at(-1)!.value;
  await poll(first.run.session.id);
  await execute("clear", first.run.session.id);
  const successor = await startNotifyRun();
  await successor.finish();
  expect(successor.run.session.id).toBe(first.run.session.id);
  await expect(receipt.settled).resolves.toMatchObject({
    status: "cancelled",
    executionStarted: false,
  });
  expect(consumeSelectedSystemEventEntries(QUEUE_KEY, snapshot)).toEqual([]);
  const queued = peekSystemEventEntries(QUEUE_KEY);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.id).not.toBe(snapshot[0]?.id);
  await poll(successor.run.session.id);
  expect(peekSystemEventEntries(QUEUE_KEY)).toEqual([]);
});

it("keeps an unpolled completion deliverable after finished-session cleanup", async () => {
  const process = await startNotifyRun();
  await process.finish();
  await execute("clear", process.run.session.id);

  expect(contexts()).toEqual([`exec:${process.run.session.id}`]);
});
