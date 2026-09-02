import { describe, expect, it, vi } from "vitest";
import {
  createIsolatedRegressionJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { run } from "./ops-run.js";
import { createCronServiceState, type CronEvent } from "./state.js";

const opsRegressionFixtures = setupCronRegressionFixtures({ prefix: "cron-service-on-exit-" });

describe("cron watcher-fired on-exit finalization", () => {
  it.each([
    {
      id: "onexit-delete-ok",
      deleteAfterRun: true,
      runStatus: "ok" as const,
      expectedJob: undefined,
      expectedActions: ["started", "finished", "removed"],
    },
    {
      id: "onexit-keep-ok",
      deleteAfterRun: false,
      runStatus: "ok" as const,
      expectedJob: { enabled: false, lastStatus: "ok" },
      expectedActions: ["started", "finished"],
    },
    {
      id: "onexit-delete-error",
      deleteAfterRun: true,
      runStatus: "error" as const,
      expectedJob: { enabled: false, lastStatus: "error" },
      expectedActions: ["started", "finished"],
    },
  ])("#104518 finalizes watcher-fired on-exit job: $id", async (params) => {
    const store = opsRegressionFixtures.makeStorePath();
    const nowMs = Date.now();
    const job = createIsolatedRegressionJob({
      id: params.id,
      name: params.id,
      scheduledAt: nowMs,
      schedule: { kind: "on-exit", command: 'sh -c "exit 0"' },
      payload: { kind: "agentTurn", message: "post-exit payload" },
      state: {},
    });
    job.deleteAfterRun = params.deleteAfterRun;
    // The gateway watcher persists this disable before force-running the payload.
    job.enabled = false;
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const events: CronEvent[] = [];
    const state = createCronServiceState({
      runSessionEvent: vi.fn(async () => ({ status: "ok" as const, executionStarted: true })),
      cronEnabled: false,
      storePath: store.storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      runIsolatedAgentJob:
        params.runStatus === "ok"
          ? vi.fn().mockResolvedValue({ status: "ok", summary: "ok", delivered: true })
          : vi.fn().mockResolvedValue({ status: "error", error: "boom" }),
      onEvent: (event) => events.push(event),
    });
    await expect(run(state, params.id, "force")).resolves.toEqual({ ok: true, ran: true });

    const memoryJob = state.store?.jobs.find((entry) => entry.id === params.id);
    const durableJob = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === params.id,
    );
    if (params.expectedJob) {
      for (const persistedJob of [memoryJob, durableJob]) {
        expect(persistedJob).toMatchObject({
          enabled: params.expectedJob.enabled,
          state: { lastStatus: params.expectedJob.lastStatus },
        });
      }
    } else {
      expect(memoryJob).toBeUndefined();
      expect(durableJob).toBeUndefined();
    }
    expect(events.map((event) => event.action)).toEqual(params.expectedActions);
  });
});
