// Capacity-edge regressions cover stopped direct runs and saturated scheduled work.
import { describe, expect, it, vi } from "vitest";
import {
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { run } from "./ops-run.js";
import { captureCronCapacityLease, runWithCronAdmission } from "./run-admission-capacity.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.test-support.js";

const capacityFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-capacity-",
});

type CronStateParams = Parameters<typeof createCronServiceState>[0] & {
  testAdmissionLimit?: number;
};

function createAdmissionTestState(params: CronStateParams) {
  const { testAdmissionLimit, ...stateParams } = params;
  const state = createCronServiceState(stateParams);
  if (testAdmissionLimit !== undefined) {
    state.runAdmission.active = DEFAULT_CRON_MAX_CONCURRENT_RUNS - testAdmissionLimit;
  }
  return state;
}

describe("cron service run admission capacity edges", () => {
  it("rechecks the caller at activation after its durable reservation waited for capacity", async () => {
    const store = capacityFixtures.makeStorePath();
    const now = Date.parse("2026-02-06T10:05:04.000Z");
    const active = createDueIsolatedJob({ id: "active-owner", nowMs: now, nextRunAtMs: now });
    const waiting = createDueIsolatedJob({ id: "waiting-owner", nowMs: now, nextRunAtMs: now });
    await saveCronStore(store.storePath, { version: 1, jobs: [active, waiting] });
    const started = createDeferred();
    const release = createDeferred();
    const execute = vi.fn(async ({ job }: { job: { id: string } }) => {
      if (job.id !== active.id) {
        throw new Error("retired caller entered execution");
      }
      started.resolve();
      await release.promise;
      return { status: "ok" as const };
    });
    const state = createAdmissionTestState({
      storePath: store.storePath,
      cronEnabled: false,
      log: noopLogger,
      nowMs: () => now,
      testAdmissionLimit: 1,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: execute,
    });
    const activeRun = run(state, active.id, "if-enabled");
    await started.promise;
    let live = true;
    const pending = run(state, waiting.id, "if-enabled", {
      delivery: { mode: "none" },
      commitGuard: () => {
        if (!live) {
          throw new Error("caller retired");
        }
      },
    });
    const rejected = expect(pending).rejects.toThrow("caller retired");
    try {
      await vi.waitFor(() => expect(state.runAdmission.waiters).toHaveLength(1));
      live = false;
    } finally {
      release.resolve();
      await activeRun;
    }
    await rejected;
    expect(execute).toHaveBeenCalledOnce();
    const persisted = (await loadCronStore(store.storePath)).jobs.find(
      (job) => job.id === waiting.id,
    )!;
    expect(persisted.state.queuedAtMs).toBeUndefined();
    expect(persisted.state.runningAtMs).toBeUndefined();
    expect(persisted.delivery).toEqual(waiting.delivery);
  });

  it.each(["active-hours", "idle"])(
    "preserves %s eligibility with a per-run delivery override",
    async (gate) => {
      const store = capacityFixtures.makeStorePath();
      const now = Date.parse("2026-02-06T10:05:04.000Z");
      const job = createDueIsolatedJob({ id: "restricted-job", nowMs: now, nextRunAtMs: now });
      if (gate === "active-hours") {
        job.activeHours = { start: "18:00", end: "19:00", timezone: "UTC" };
      } else {
        job.idleOnly = true;
      }
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const execute = vi.fn(async () => {
        throw new Error("restricted job executed");
      });
      const state = createCronServiceState({
        storePath: store.storePath,
        cronEnabled: false,
        log: noopLogger,
        nowMs: () => now,
        isExecutionIdle: () => false,
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: execute,
      });
      const settled = vi.fn();
      await run(state, job.id, "if-enabled", {
        delivery: { mode: "none" },
        onSettledResult: settled,
      });
      expect(execute).not.toHaveBeenCalled();
      if (gate === "active-hours") {
        expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
      }
      const retained = (await loadCronStore(store.storePath)).jobs[0]!;
      expect(retained.delivery).toEqual(job.delivery);
      expect(retained.activeHours).toEqual(job.activeHours);
      expect(retained.idleOnly).toBe(job.idleOnly);
    },
  );

  it("releases a direct manual reservation when stop wins its admission wait", async () => {
    const store = capacityFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:07.000Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-manual-stop",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const waitingJob = createDueIsolatedJob({
      id: "stopped-manual-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, waitingJob] });

    const activeStarted = createDeferred();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
        if (runningJob.id === activeJob.id) {
          activeStarted.resolve();
          return await releaseActive.promise;
        }
        return { status: "ok" as const, summary: "should not run" };
      }),
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    const waitingRun = run(state, waitingJob.id, "force");
    await vi.waitFor(() => {
      expect(state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.queuedAtMs).toBe(
        dueAt,
      );
    });
    stop(state);
    await expect(waitingRun).resolves.toEqual({ ok: true, ran: false, reason: "stopped" });
    expect(
      state.store?.jobs.find((job) => job.id === waitingJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    expect(state.queuedRunReservationsByJobId.has(waitingJob.id)).toBe(false);
    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
  });

  it("keeps saturated scheduled work unreserved when it is rescheduled", async () => {
    const store = capacityFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:08.000Z");
    const activeJob = createDueIsolatedJob({
      id: "active-before-scheduled-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    const scheduledJob = createDueIsolatedJob({
      id: "rescheduled-scheduled-admission",
      nowMs: dueAt,
      nextRunAtMs: dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [activeJob, scheduledJob] });

    const activeStarted = createDeferred();
    const releaseActive = createDeferred<{ status: "ok"; summary: string }>();
    const runIsolatedAgentJob = vi.fn(async ({ job: runningJob }: { job: { id: string } }) => {
      if (runningJob.id === activeJob.id) {
        activeStarted.resolve();
        return await releaseActive.promise;
      }
      return { status: "ok" as const, summary: "should not run" };
    });
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      nowMs: () => dueAt,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob,
    });

    const activeRun = run(state, activeJob.id, "force");
    await activeStarted.promise;
    await onTimer(state);
    expect(
      state.store?.jobs.find((job) => job.id === scheduledJob.id)?.state.queuedAtMs,
    ).toBeUndefined();
    expect(
      inspectActiveCronRunReceipt({
        storePath: store.storePath,
        jobId: scheduledJob.id,
      }),
    ).toBeUndefined();
    await update(state, scheduledJob.id, {
      schedule: { kind: "at", at: new Date(dueAt + 3_600_000).toISOString() },
    });

    releaseActive.resolve({ status: "ok", summary: "active" });
    await activeRun;
    await vi.waitFor(() => expect(state.runAdmission.capacityListener).toBeNull());
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(
      state.store?.jobs.find((job) => job.id === scheduledJob.id)?.state.runningAtMs,
    ).toBeUndefined();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), scheduledJob.id) as { status: string } | undefined;
    expect(receipt).toBeUndefined();
  });
  it("releases the existing slot while a session turn is queued, then reacquires it once", async () => {
    const store = capacityFixtures.makeStorePath();
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const queued = createDeferred();
    const adopt = createDeferred();
    const first = runWithCronAdmission(state, async () => {
      const capacity = captureCronCapacityLease()!;
      capacity.suspend();
      queued.resolve();
      await adopt.promise;
      await Promise.all([capacity.resume(), capacity.resume()]);
      expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    });
    await queued.promise;
    await expect(runWithCronAdmission(state, async () => "other job")).resolves.toEqual({
      kind: "admitted",
      value: "other job",
    });
    adopt.resolve();
    await first;
    expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
  });

  it("cancels an adopted session turn's capacity waiter without waiting for another job", async () => {
    const store = capacityFixtures.makeStorePath();
    const state = createAdmissionTestState({
      cronEnabled: true,
      storePath: store.storePath,
      testAdmissionLimit: 1,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const resume = createDeferred();
    const suspended = createDeferred();
    const controller = new AbortController();
    const queued = runWithCronAdmission(state, async () => {
      const lease = captureCronCapacityLease()!;
      lease.suspend();
      suspended.resolve();
      await resume.promise;
      await lease.resume(controller.signal);
    });
    const cancelled = expect(queued).rejects.toThrow("admission stopped");
    await suspended.promise;
    const release = createDeferred();
    const occupied = runWithCronAdmission(state, async () => {
      resume.resolve();
      await release.promise;
    });
    await vi.waitFor(() => expect(state.runAdmission.waiters).toHaveLength(1));
    controller.abort();
    await cancelled;
    expect(state.runAdmission.waiters).toHaveLength(0);
    release.resolve();
    await occupied;
    expect(state.runAdmission.active).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS - 1);
  });
});
