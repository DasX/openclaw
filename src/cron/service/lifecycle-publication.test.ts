// Cron service store tests cover persisted service state loading and writes.

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  createDefaultProactiveJob,
  provisionDefaultProactiveJob,
} from "../default-proactive-job.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../proactive-job-receipt.js";
import { writeCronJobScratch } from "../scratch-store.js";
import { CronService } from "../service.js";
import {
  createStartedCronServiceWithFinishedBarrier,
  setupCronServiceSuite,
} from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-lifecycle-publication" });

describe("explicit lifecycle job adoption", () => {
  it("schedules a provisioned job from an empty timer without a read, and never resurrects deletion", async () => {
    const { storePath } = await makeStorePath();
    const cfg = { agents: { entries: { main: {} } }, cron: { store: storePath } } as OpenClawConfig;
    const added = createDeferred();
    const removed = createDeferred();
    const finished = createDeferred();
    const runSessionEvent = vi.fn(async () => ({ status: "ok" as const, executionStarted: true }));
    const cron = new CronService({
      storePath,
      log: logger,
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      isExecutionIdle: () => true,
      runSessionEvent,
      onEvent: (event) => {
        if (event.action === "added") {
          added.resolve();
        }
        if (event.action === "removed") {
          removed.resolve();
        }
        if (event.action === "finished" && event.status === "ok") {
          finished.resolve();
        }
      },
    });
    try {
      await cron.start();
      const job = provisionDefaultProactiveJob(cfg, "main", { cadenceMs: 60_000 })!;
      const receipt = readDefaultProactiveJobReceiptInDatabase(
        openOpenClawStateDatabase().db,
        storePath,
        "main",
      );
      expect(receipt?.jobId).toBe(job.id);
      writeCronJobScratch({
        storePath,
        jobId: job.id,
        content: "Check the queue",
        expectedRevision: 0,
      });
      await added.promise;
      expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await finished.promise;
      expect(runSessionEvent).toHaveBeenCalledOnce();
      cronStoreModule.mutateCronJobsStore(storePath, ({ remove }) => remove(job.id));
      await removed.promise;
      expect(cron.getJob(job.id)).toBeUndefined();
      expect(provisionDefaultProactiveJob(cfg, "main", { cadenceMs: 60_000 })).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runSessionEvent).toHaveBeenCalledOnce();
    } finally {
      cron.stop();
    }
  });

  it("fences lifecycle updates and removal against a receipt even before run markers exist", async () => {
    const { storePath } = await makeStorePath();
    const job = createDefaultProactiveJob({}, "main", Date.now());
    cronStoreModule.mutateCronJobsStore(storePath, ({ upsert }) => upsert(job));
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "main",
      startedAtMs: Date.now(),
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({ database: db, prepared, resolveAgentId: () => "main" }),
    );
    try {
      expect(() =>
        cronStoreModule.mutateCronJobsStore(storePath, ({ upsert }) =>
          upsert({ ...job, enabled: false }),
        ),
      ).toThrow("active run receipt");
      expect(() =>
        cronStoreModule.mutateCronJobsStore(storePath, ({ remove }) => remove(job.id)),
      ).toThrow("active run receipt");
      expect((await loadCronStore(storePath)).jobs).toEqual([job]);
    } finally {
      finishCronRunReceipt({ handle: receipt, status: "superseded", finishedAtMs: Date.now() });
    }
  });

  it("publishes only outer commits and loads offline adoption on normal restart", async () => {
    const { storePath } = await makeStorePath();
    const added = vi.fn();
    const unsubscribe = cronStoreModule.subscribeCronJobsStoreMutations(storePath, added);
    const service = createStartedCronServiceWithFinishedBarrier({ storePath, logger });
    const job = createDefaultProactiveJob({}, "main", Date.now());
    try {
      await service.cron.start();
      service.cron.stop();
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          cronStoreModule.mutateCronJobsStore(storePath, ({ upsert }) => upsert(job));
          expect(added).not.toHaveBeenCalled();
          throw new Error("provenance failed");
        }),
      ).toThrow("provenance failed");
      expect(added).not.toHaveBeenCalled();
      expect((await loadCronStore(storePath)).jobs).toEqual([]);
      runOpenClawStateWriteTransaction(() => {
        cronStoreModule.mutateCronJobsStore(storePath, ({ upsert }) => upsert(job));
        expect(added).not.toHaveBeenCalled();
      });
      expect(added).toHaveBeenCalledOnce();
      expect(service.cron.getJob(job.id)).toBeUndefined();
      await service.cron.start();
      expect(service.cron.getJob(job.id)?.id).toBe(job.id);
    } finally {
      unsubscribe();
      service.cron.stop();
    }
  });
});
