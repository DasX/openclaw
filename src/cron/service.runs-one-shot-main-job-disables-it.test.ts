// One-shot main job tests cover disabling cron jobs after a single run.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-runs-one-shot-",
});

function createCronEventHarness() {
  const events: CronEvent[] = [];
  const waiters: Array<{
    predicate: (evt: CronEvent) => boolean;
    deferred: ReturnType<typeof createDeferred<CronEvent>>;
  }> = [];

  const onEvent = (evt: CronEvent) => {
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.predicate(evt)) {
        waiters.splice(i, 1);
        waiter.deferred.resolve(evt);
      }
    }
  };

  const waitFor = (predicate: (evt: CronEvent) => boolean) => {
    for (const evt of events) {
      if (predicate(evt)) {
        return Promise.resolve(evt);
      }
    }
    const deferred = createDeferred<CronEvent>();
    waiters.push({ predicate, deferred });
    return deferred.promise;
  };

  return { onEvent, waitFor, events };
}

type CronHarnessOptions = {
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  runSessionEvent?: CronServiceDeps["runSessionEvent"];
  nowMs?: () => number;
  withEvents?: boolean;
};

async function createCronHarness(options: CronHarnessOptions = {}) {
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const runSessionEvent =
    options.runSessionEvent ??
    vi.fn(async () => ({ status: "ok" as const, executionStarted: true }));
  const events = options.withEvents === false ? undefined : createCronEventHarness();
  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    enqueueSystemEvent,
    runSessionEvent,
    runIsolatedAgentJob:
      options.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
    ...(events ? { onEvent: events.onEvent } : {}),
  });
  await cron.start();
  return { store, cron, enqueueSystemEvent, runSessionEvent, events };
}

async function createMainOneShotHarness() {
  const harness = await createCronHarness();
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function createIsolatedAnnounceHarness(
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"],
) {
  const harness = await createCronHarness({
    runIsolatedAgentJob,
  });
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function addDefaultIsolatedAnnounceJob(cron: CronService, name: string) {
  const runAt = new Date("2025-12-13T00:00:01.000Z");
  const job = await cron.add({
    enabled: true,
    name,
    schedule: { kind: "at", at: runAt.toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce" },
  });
  return { job, runAt };
}

async function runIsolatedAnnounceJobAndWait(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status: "ok" | "error";
}) {
  const { job, runAt } = await addDefaultIsolatedAnnounceJob(params.cron, params.name);
  vi.setSystemTime(runAt);
  await vi.runOnlyPendingTimersAsync();
  await params.events.waitFor(
    (evt) => evt.jobId === job.id && evt.action === "finished" && evt.status === params.status,
  );
  return job;
}

async function runIsolatedAnnounceScenario(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status?: "ok" | "error";
}) {
  await runIsolatedAnnounceJobAndWait({
    cron: params.cron,
    events: params.events,
    name: params.name,
    status: params.status ?? "ok",
  });
}

async function addWakeModeNowMainSystemEventJob(
  cron: CronService,
  options?: { name?: string; agentId?: string; sessionKey?: string },
) {
  return cron.add({
    name: options?.name ?? "wakeMode now",
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    ...(options?.sessionKey ? { sessionKey: options.sessionKey } : {}),
    enabled: true,
    schedule: { kind: "at", at: new Date(1).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

async function addMainOneShotHelloJob(
  cron: CronService,
  params: { atMs: number; name: string; deleteAfterRun?: boolean },
) {
  return cron.add({
    name: params.name,
    enabled: true,
    ...(params.deleteAfterRun === undefined ? {} : { deleteAfterRun: params.deleteAfterRun }),
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

function expectMainSessionRun(runSessionEvent: CronServiceDeps["runSessionEvent"], jobId: string) {
  expect(runSessionEvent).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      job: expect.objectContaining({ id: jobId }),
      text: "hello",
    }),
  );
}

async function stopCronAndCleanup(cron: CronService, store: { cleanup: () => Promise<void> }) {
  await cron.status();
  cron.stop();
  await store.cleanup();
}

function createStartedCronService(
  storePath: string,
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"],
) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    runSessionEvent: vi.fn(async () => ({ status: "ok" as const, executionStarted: true })),
    runIsolatedAgentJob: runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
  });
}

async function createMainOneShotJobHarness(params: { name: string; deleteAfterRun?: boolean }) {
  const harness = await createMainOneShotHarness();
  const atMs = Date.parse("2025-12-13T00:00:02.000Z");
  const job = await addMainOneShotHelloJob(harness.cron, {
    atMs,
    name: params.name,
    deleteAfterRun: params.deleteAfterRun,
  });
  return { ...harness, atMs, job };
}

async function expectNoMainSummaryForIsolatedRun(params: {
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
  name: string;
}) {
  const { store, cron, enqueueSystemEvent, runSessionEvent, events } =
    await createIsolatedAnnounceHarness(params.runIsolatedAgentJob);
  await runIsolatedAnnounceScenario({
    cron,
    events,
    name: params.name,
  });
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  expect(runSessionEvent).not.toHaveBeenCalled();
  await stopCronAndCleanup(cron, store);
}

describe("CronService", () => {
  it("runs a one-shot main job and disables it after success when requested", async () => {
    const { store, cron, enqueueSystemEvent, runSessionEvent, events, atMs, job } =
      await createMainOneShotJobHarness({
        name: "one-shot hello",
        deleteAfterRun: false,
      });

    expect(job.state.nextRunAtMs).toBe(atMs);

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "finished");

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expectMainSessionRun(runSessionEvent, job.id);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    await cron.list({ includeDisabled: true });
    await stopCronAndCleanup(cron, store);
  });

  it("runs a one-shot job and deletes it after success by default", async () => {
    const { store, cron, enqueueSystemEvent, runSessionEvent, events, job } =
      await createMainOneShotJobHarness({
        name: "one-shot delete",
      });

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "removed");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expectMainSessionRun(runSessionEvent, job.id);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    await stopCronAndCleanup(cron, store);
  });

  it.each([
    { name: "default delivery failure", bestEffort: undefined, expectedCompletion: "failed" },
    { name: "required delivery failure", bestEffort: false, expectedCompletion: "failed" },
    {
      name: "transport hook suppression",
      bestEffort: undefined,
      error: "delivery suppressed by message_sending hook",
      expectedCompletion: "failed",
    },
    { name: "best-effort delivery failure", bestEffort: true, expectedCompletion: "succeeded" },
    {
      name: "unknown delivery",
      bestEffort: undefined,
      unknown: true,
      expectedCompletion: "unknown",
    },
    {
      name: "best-effort unknown delivery",
      bestEffort: true,
      unknown: true,
      expectedCompletion: "succeeded",
    },
    ...(["empty", "silent", "heartbeat", "channel_transform"] as const).map((reason) => ({
      name: `${reason} suppression`,
      bestEffort: false,
      reason,
      expectedCompletion: "succeeded",
    })),
  ])("cleans up $name once across restart", async (testCase) => {
    const unknown = "unknown" in testCase && testCase.unknown;
    const reason = "reason" in testCase ? testCase.reason : undefined;
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "payload completed",
      delivered: unknown ? undefined : false,
      deliveryError:
        unknown || reason ? undefined : "error" in testCase ? testCase.error : "delivery rejected",
      deliverySuppressionReason: reason,
    }));
    const { store, cron, events } = await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    const runAt = new Date("2025-12-13T00:00:03.000Z");
    const job = await cron.add({
      name: "required one-shot",
      enabled: true,
      schedule: { kind: "at", at: runAt.toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it once" },
      delivery: { mode: "announce", bestEffort: testCase.bestEffort },
    });

    vi.setSystemTime(runAt);
    await vi.runOnlyPendingTimersAsync();
    const event = await events.waitFor(
      (candidate) => candidate.jobId === job.id && candidate.action === "finished",
    );
    const retained = cron.getJob(job.id);

    expect(event).toMatchObject({
      status: "ok",
      completionStatus: testCase.expectedCompletion,
      deliveryStatus: unknown ? "unknown" : "not-delivered",
      ...(reason ? { deliverySuppressionReason: reason } : {}),
    });
    const shouldDelete = testCase.expectedCompletion === "succeeded";
    if (shouldDelete) {
      expect(retained).toBeUndefined();
    } else {
      expect(retained).toMatchObject({
        enabled: false,
        state: {
          lastRunStatus: "ok",
          consecutiveErrors: 0,
        },
      });
    }
    expect(retained?.state.nextRunAtMs).toBeUndefined();
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();

    cron.stop();
    const restartedRun = vi.fn(async () => ({ status: "ok" as const }));
    const restarted = createStartedCronService(store.storePath, restartedRun);
    await restarted.start();
    await vi.runOnlyPendingTimersAsync();
    expect(restartedRun).not.toHaveBeenCalled();
    if (shouldDelete) {
      expect(restarted.getJob(job.id)).toBeUndefined();
    } else {
      expect(restarted.getJob(job.id)).toMatchObject({ enabled: false });
    }

    await stopCronAndCleanup(restarted, store);
  });

  it("counts the next execution error from one after a delivery-only failure", async () => {
    const runIsolatedAgentJob = vi
      .fn()
      .mockResolvedValueOnce({
        status: "ok" as const,
        delivered: false,
        deliveryError: "delivery rejected",
      })
      .mockResolvedValueOnce({
        status: "error" as const,
        error: "provider overloaded",
      });
    const { store, cron, events } = await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    const job = await cron.add({
      name: "delivery then execution error",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "run" },
      delivery: { mode: "announce", bestEffort: false },
    });

    const firstAt = job.state.nextRunAtMs!;
    vi.setSystemTime(firstAt);
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor(
      (candidate) => candidate.jobId === job.id && candidate.action === "finished",
    );
    const secondAt = cron.getJob(job.id)?.state.nextRunAtMs;
    expect(secondAt).toBeTypeOf("number");
    expect(cron.getJob(job.id)?.state.consecutiveErrors).toBe(0);

    vi.setSystemTime(secondAt!);
    await vi.runOnlyPendingTimersAsync();
    await vi.waitFor(() => expect(runIsolatedAgentJob).toHaveBeenCalledTimes(2));
    const updated = cron.getJob(job.id);
    expect(updated).toMatchObject({
      enabled: true,
      state: {
        lastRunStatus: "error",
        consecutiveErrors: 1,
      },
    });
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(secondAt!);

    await stopCronAndCleanup(cron, store);
  });

  it("deletes a recurring job converted to at when retention is omitted", async () => {
    const { store, cron, events } = await createMainOneShotHarness();
    const job = await cron.add({
      name: "converted one-shot delete",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "converted" },
    });
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");

    const updated = await cron.update(job.id, {
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
    });
    expect(updated.deleteAfterRun).toBe(true);

    vi.setSystemTime(atMs);
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "removed");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((candidate) => candidate.id === job.id)).toBeUndefined();
    await stopCronAndCleanup(cron, store);
  });

  it("keeps a recurring job converted to at when explicitly requested", async () => {
    const { store, cron, events } = await createMainOneShotHarness();
    const job = await cron.add({
      name: "converted one-shot keep",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "converted" },
    });
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");

    const updated = await cron.update(job.id, {
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      deleteAfterRun: false,
    });
    expect(updated.deleteAfterRun).toBe(false);

    vi.setSystemTime(atMs);
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "finished");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((candidate) => candidate.id === job.id)?.enabled).toBe(false);
    await stopCronAndCleanup(cron, store);
  });

  it("records terminal session failure without a second passive event or retry", async () => {
    const runSessionEvent = vi.fn(async () => ({
      status: "error" as const,
      error: "session execution failed",
      executionStarted: true,
    }));
    const { store, cron, enqueueSystemEvent } = await createCronHarness({ runSessionEvent });
    const job = await addWakeModeNowMainSystemEventJob(cron, { name: "failed session turn" });
    await cron.run(job.id, "force");
    expectMainSessionRun(runSessionEvent, job.id);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(cron.getJob(job.id)).toMatchObject({
      enabled: false,
      state: { lastRunStatus: "error", lastError: "session execution failed" },
    });
    await stopCronAndCleanup(cron, store);
  });

  it("rejects sessionTarget main for non-default agents at creation time", async () => {
    const { store, cron } = await createCronHarness();
    await expect(addWakeModeNowMainSystemEventJob(cron, { agentId: "ops" })).rejects.toThrow(
      'cron: sessionTarget "main" is only valid for the default agent',
    );
    await stopCronAndCleanup(cron, store);
  });

  it("runs an isolated job without posting a fallback summary to main", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const { store, cron, enqueueSystemEvent, runSessionEvent, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceScenario({ cron, events, name: "weekly" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runSessionEvent).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("does not post isolated summary to main when run already delivered output", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: true,
    }));
    await expectNoMainSummaryForIsolatedRun({
      runIsolatedAgentJob,
      name: "weekly delivered",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post isolated summary to main when announce delivery was attempted", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: false,
      deliveryAttempted: true,
    }));
    await expectNoMainSummaryForIsolatedRun({
      runIsolatedAgentJob,
      name: "weekly attempted",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post a fallback main summary when an isolated job errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "boom",
    }));
    const { store, cron, enqueueSystemEvent, runSessionEvent, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runSessionEvent).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("retries one-shot lifecycle claim conflicts instead of disabling the job (#106875)", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
    }));
    const { store, cron, events } = await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    const job = await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "one-shot lifecycle claim retry",
      status: "error",
    });

    const updated = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === job.id,
    );
    expect(updated?.enabled).toBe(true);
    expect(updated?.state.consecutiveErrors).toBe(1);
    expect(updated?.state.nextRunAtMs).toBeTypeOf("number");

    await stopCronAndCleanup(cron, store);
  });

  it("does not retry a lifecycle claim conflict after agent execution starts (#108428)", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
      executionStarted: true,
    }));
    const { store, cron, events } = await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    const job = await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "post-execution lifecycle claim conflict",
      status: "error",
    });

    const updated = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === job.id,
    );
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.consecutiveErrors).toBe(1);
    expect(updated?.state.nextRunAtMs).toBeUndefined();

    await stopCronAndCleanup(cron, store);
  });

  it("does not post fallback main summary for isolated delivery-target errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "Channel is required when multiple channels are configured: telegram, discord",
      errorKind: "delivery-target" as const,
    }));
    const { store, cron, enqueueSystemEvent, runSessionEvent, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated delivery target error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(runSessionEvent).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("rejects unsupported session/payload combinations", async () => {
    const store = await makeStorePath();

    const cron = createStartedCronService(
      store.storePath,
      vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok" as const,
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
    );

    await cron.start();

    await expect(
      cron.add({
        name: "bad combo (main/agentTurn)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).rejects.toThrow(/main cron jobs require/);

    await expect(
      cron.add({
        name: "bad combo (isolated/systemEvent)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "nope" },
      }),
    ).rejects.toThrow(/isolated.*cron jobs require/);

    await stopCronAndCleanup(cron, store);
  });
});
