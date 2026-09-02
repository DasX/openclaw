import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { readCronJobScratchState, writeCronJobScratch } from "./scratch-store.js";
import { CronService, type CronEvent } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { cronStoreKey } from "./store/key.js";
import { readCronTaskRunHistoryPage } from "./task-run-history.js";

const stores = createCronStoreHarness({ prefix: "cron-session-turn-" });
const services: CronService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) {
    service.stop();
  }
});

describe("ordinary cron session execution", () => {
  it.each(["force", "queued", "natural"] as const)(
    "%s waits for real execution settlement exactly once",
    async (mode) => {
      const { storePath } = await stores.makeStorePath();
      const entered = createDeferredCore();
      const finish = createDeferredCore<{
        status: "ok";
        summary: string;
        executionStarted: true;
      }>();
      const terminal = createDeferredCore<CronEvent>();
      const events: CronEvent[] = [];
      const runSessionEvent = vi.fn(async () => {
        entered.resolve();
        return await finish.promise;
      });
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        runIsolatedAgentJob: vi.fn(),
        onEvent(event) {
          events.push(event);
          if (event.action === "finished") {
            terminal.resolve(event);
          }
        },
      });
      services.push(cron);
      await cron.start();
      const job = await cron.add({
        name: "session reminder",
        enabled: true,
        schedule: {
          kind: "at",
          at: new Date(Date.now() + (mode === "natural" ? 100 : 60_000)).toISOString(),
        },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Check the completed work" },
      });
      const execution =
        mode === "force"
          ? cron.run(job.id, "force")
          : mode === "queued"
            ? cron.enqueueRun(job.id, "force")
            : Promise.resolve();
      await entered.promise;
      expect(events.filter((event) => event.action === "finished")).toEqual([]);
      finish.resolve({ status: "ok", summary: "Handled", executionStarted: true });
      await execution;
      await expect(terminal.promise).resolves.toMatchObject({
        jobId: job.id,
        status: "ok",
        summary: "Handled",
      });
      expect(runSessionEvent).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["absent", undefined, true, "announce"],
    ["empty", "", false, "announce"],
    ["empty none", "", false, "none"],
    ["comments", "# Checklist\n<!-- empty -->\n- [ ]\n", false, "announce"],
    ["tombstone", null, true, "announce"],
    ["action", "Check the backup", true, "announce"],
  ] as const)(
    "executes the scheduled scratch policy for %s content",
    async (_label, content, runs, mode) => {
      const { storePath } = await stores.makeStorePath();
      const runSessionEvent = vi.fn(async () => ({
        status: "ok" as const,
        executionStarted: true,
      }));
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        runIsolatedAgentJob: vi.fn(),
      });
      services.push(cron);
      const job = await cron.add({
        name: "scratch check",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:agent:main:main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "check", skipIfScratchEmpty: true },
        delivery: { mode, channel: "telegram", to: "123" },
      });
      if (content !== undefined) {
        expect(
          writeCronJobScratch({ storePath, jobId: job.id, content, expectedRevision: 0 }).ok,
        ).toBe(true);
      }
      const before = readCronJobScratchState(storePath, job.id);
      const beforeJob = structuredClone(job);
      await cron.run(job.id, "force");
      expect(runSessionEvent).toHaveBeenCalledTimes(runs ? 1 : 0);
      const after = await cron.readJob(job.id);
      expect(after?.state.lastRunStatus).toBe(runs ? "ok" : "skipped");
      expect(after?.state.lastDeliveryStatus).toBe(
        mode === "none" ? "not-requested" : runs ? "unknown" : "not-delivered",
      );
      if (!runs) {
        expect(after?.state.lastError).toBeUndefined();
        expect(after?.schedule).toEqual(beforeJob.schedule);
        expect(after?.state.nextRunAtMs).toBe(beforeJob.state.nextRunAtMs);
        expect(
          readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId: job.id })
            .entries[0],
        ).toMatchObject({
          status: "skipped",
          completionStatus: "failed",
          deliveryStatus: mode === "none" ? "not-requested" : "not-delivered",
        });
      }
      expect(readCronJobScratchState(storePath, job.id)).toEqual(before);
    },
  );

  it.each([
    ["active hours", "announce", false, "not-delivered"],
    ["active hours", "none", false, "not-requested"],
    ["active hours", "webhook", false, "delivered"],
    ["empty scratch", "webhook", false, "delivered"],
    ["empty scratch", "webhook", true, "not-delivered"],
    ["started", "announce", false, "unknown"],
  ] as const)(
    "records %s with %s (webhook failure %s)",
    async (reason, mode, webhookFails, deliveryStatus) => {
      const { storePath } = await stores.makeStorePath();
      const events: CronEvent[] = [];
      const runSessionEvent = vi.fn(async () => ({
        status: "skipped" as const,
        executionStarted: true,
        deliveryAttempted: true,
        summary: "Started work has an unverified delivery",
        deliveryState: {
          status: "unknown" as const,
          failureNotification: { status: "not-requested" as const },
        },
      }));
      const sendCronWebhook = vi.fn(async () => {
        if (webhookFails) {
          throw new Error("webhook refused");
        }
      });
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        sendCronWebhook,
        runIsolatedAgentJob: vi.fn(),
        onEvent: (event) => {
          events.push(event);
        },
      });
      services.push(cron);
      const job = await cron.add({
        name: "preflight facts",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
        ...(reason === "active hours"
          ? { activeHours: { start: "00:00", end: "00:00", timezone: "UTC" } }
          : {}),
        sessionTarget: "session:agent:main:main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "check", skipIfScratchEmpty: true },
        delivery:
          mode === "webhook"
            ? { mode, to: "https://example.invalid/result" }
            : { mode, channel: "telegram", to: "123" },
      });
      if (reason === "empty scratch") {
        writeCronJobScratch({ storePath, jobId: job.id, content: "", expectedRevision: 0 });
      }
      const beforeJob = structuredClone(job);
      await cron.run(job.id, "force");
      expect(runSessionEvent).toHaveBeenCalledTimes(reason === "started" ? 1 : 0);
      expect(sendCronWebhook).toHaveBeenCalledTimes(mode === "webhook" ? 1 : 0);
      const terminal = events.find((event) => event.action === "finished");
      expect(terminal).toMatchObject({
        status: "skipped",
        completionStatus: "failed",
        deliveryStatus,
      });
      const after = await cron.readJob(job.id);
      expect(after).toBeDefined(); // A skipped one-shot is retained, never treated as succeeded.
      expect(after?.enabled).toBe(true);
      expect(after?.state.nextRunAtMs).toBe(beforeJob.state.nextRunAtMs);
      expect(after?.state.lastError).toBeUndefined();
      expect(after?.state.consecutiveErrors).toBe(0);
      expect(after?.state.lastFailureNotificationDeliveryStatus).toBe("not-requested");
      expect(after?.state.lastDeliveryError).toBe(webhookFails ? "webhook refused" : undefined);
      expect(
        readCronTaskRunHistoryPage({ storeKey: cronStoreKey(storePath), jobId: job.id }).entries[0],
      ).toMatchObject({ status: "skipped", completionStatus: "failed", deliveryStatus });
    },
  );

  it.each([false, undefined])(
    "manual execution defers when idle is %s without consuming its pending schedule",
    async (idle) => {
      const { storePath } = await stores.makeStorePath();
      const runSessionEvent = vi.fn();
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        ...(idle === undefined ? {} : { isExecutionIdle: () => idle }),
        runIsolatedAgentJob: vi.fn(),
      });
      services.push(cron);
      const job = await cron.add({
        name: "idle check",
        enabled: true,
        idleOnly: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:agent:main:main",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "check" },
        delivery: { mode: "none" },
      });
      const next = job.state.nextRunAtMs;
      await expect(cron.run(job.id, "force")).resolves.toMatchObject({
        ran: false,
        reason: "not-due",
      });
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect((await cron.readJob(job.id))?.state.nextRunAtMs).toBe(next);
    },
  );
});
