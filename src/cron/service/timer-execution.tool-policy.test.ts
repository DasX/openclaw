import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronStoredJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";
import { applyJobResult } from "./timer-outcomes.js";

function damagedPinnedJob(kind: "trigger" | "script" | "agentTurn"): CronStoredJob {
  const payload: CronStoredJob["payload"] =
    kind === "script"
      ? { kind: "script", script: "return {}", toolsAllow: ["exec"] }
      : { kind: "agentTurn", message: "run", toolsAllow: ["exec"] };
  return {
    ...makeCronJob({
      payload,
      ...(kind === "trigger" ? { trigger: { script: "return { fire: true }" } } : {}),
    }),
    toolsAllowExecTargetRequirement: {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    },
  };
}

describe("scheduled exec target recovery", () => {
  it.each(["before-trigger", "after-trigger"])(
    "fences a retired caller %s, including no-fire results",
    async (stage) => {
      let live = stage === "after-trigger";
      const evaluateCronTrigger = vi.fn(async () => {
        live = false;
        return { kind: "evaluated" as const, fire: false };
      });
      const runIsolatedAgentJob = vi.fn();
      const state = createCronServiceState({
        storePath: "/tmp/cron-caller-trigger.json",
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        evaluateCronTrigger,
        runIsolatedAgentJob,
      });
      await expect(
        executeJobCore(
          state,
          makeCronJob({ trigger: { script: "json({fire:false})" } }),
          undefined,
          {
            assertRunCurrent: () => {
              if (!live) {
                throw new Error("caller retired");
              }
            },
          },
        ),
      ).rejects.toThrow("caller retired");
      expect(evaluateCronTrigger).toHaveBeenCalledTimes(stage === "before-trigger" ? 0 : 1);
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    },
  );

  it("waits for a main session turn's terminal result without invoking a heartbeat", async () => {
    let settle!: (value: { status: "ok"; summary: string; executionStarted: boolean }) => void;
    const execution = new Promise<{ status: "ok"; summary: string; executionStarted: boolean }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const runSessionEvent = vi.fn(() => execution);
    const state = createCronServiceState({
      storePath: "/tmp/cron-main-session-settlement.json",
      cronEnabled: false,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runSessionEvent,
      runIsolatedAgentJob: vi.fn(),
    });
    let finished = false;
    const result = executeJobCore(
      state,
      makeCronJob({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "Reminder" },
      }),
    ).then((value) => {
      finished = true;
      return value;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(runSessionEvent).toHaveBeenCalledOnce();
    settle({ status: "ok", summary: "Handled", executionStarted: true });
    await expect(result).resolves.toMatchObject({
      status: "ok",
      summary: "Handled",
      executionStarted: true,
    });
  });

  it("keeps the isolated pending slot when foreground work wins before model start", async () => {
    const state = createCronServiceState({
      storePath: "/tmp/cron-isolated-deferred.json",
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "skipped" as const,
        executionStarted: false,
        admissionDeferred: true,
      })),
    });
    const job = makeCronJob({
      idleOnly: true,
      state: { nextRunAtMs: 1000, lastRunAtMs: 500, lastRunStatus: "ok" },
    });
    const outcome = await executeJobCore(state, job);
    applyJobResult(state, job, { ...outcome, startedAt: 1000, endedAt: 2000 });
    expect(job.state).toMatchObject({ nextRunAtMs: 1000, lastRunAtMs: 500, lastRunStatus: "ok" });
    expect(job.state.lastDurationMs).toBeUndefined();
  });

  it.each(["main", "isolated"] as const)(
    "does not replay a trigger that ran before %s admission was deferred",
    async (sessionTarget) => {
      const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
      const state = createCronServiceState({
        storePath: "/tmp/cron-trigger-deferred.json",
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        evaluateCronTrigger,
        runSessionEvent: vi.fn(async () => ({
          status: "skipped" as const,
          executionStarted: false,
          admissionDeferred: true,
        })),
        runIsolatedAgentJob: vi.fn(async () => ({
          status: "skipped" as const,
          executionStarted: false,
          admissionDeferred: true,
        })),
      });
      const job = makeCronJob({
        sessionTarget,
        idleOnly: true,
        trigger: { script: "perform_trigger_work(); return { fire: true }" },
        state: { nextRunAtMs: 1000, lastRunAtMs: 500, lastRunStatus: "ok" },
      });
      const outcome = await executeJobCore(state, job);
      applyJobResult(state, job, { ...outcome, startedAt: 1000, endedAt: 2000 });
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      expect(job.state.lastRunStatus).toBe("skipped");
      expect(job.state.nextRunAtMs).toBeGreaterThan(1000);
    },
  );

  it("applies the execution window before any trigger or payload side effect", async () => {
    const evaluateCronTrigger = vi.fn();
    const runIsolatedAgentJob = vi.fn();
    const state = createCronServiceState({
      storePath: "/tmp/cron-window-policy.json",
      cronEnabled: true,
      nowMs: () => Date.parse("2026-09-01T08:00:00Z"),
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      evaluateCronTrigger,
      runIsolatedAgentJob,
    });
    await expect(
      executeJobCore(
        state,
        makeCronJob({
          activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
          trigger: { script: "json({fire:true})" },
        }),
      ),
    ).resolves.toMatchObject({
      status: "skipped",
      summary: expect.stringContaining("active hours"),
    });
    expect(evaluateCronTrigger).not.toHaveBeenCalled();
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it.each(["trigger", "script", "agentTurn"] as const)(
    "stops a damaged pinned %s job before executable work",
    async (kind) => {
      const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
      const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath: `/tmp/cron-exec-target-recovery-${kind}.json`,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        evaluateCronTrigger,
        runScriptJob,
        runIsolatedAgentJob,
      });

      const result = await executeJobCore(state, damagedPinnedJob(kind));

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("captured exec restriction is missing or invalid"),
      });
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      expect(runScriptJob).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy unmarked exec grants on baseline policy", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath: "/tmp/cron-exec-target-legacy.json",
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob,
    });
    const job = makeCronJob({
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["exec"] },
    });

    await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
  });
});
