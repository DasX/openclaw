import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";
const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

describe("skill collection review execution", () => {
  it("executes skill collection review payloads through the injected runner", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const runSkillCollectionReview = vi.fn(async ({ agentId }: { agentId: string }) => ({
      status: "ok" as const,
      summary: `reviewed ${agentId}`,
    }));
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      runSkillCollectionReview,
    });
    try {
      await cron.start();
      const added = await cron.add(
        {
          declarationKey: "skill-collection-review:main",
          name: "skill-collection-review-main",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
          payload: { kind: "skillCollectionReview" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { enabledExplicit: true, systemOwned: true },
      );
      const job = "job" in added ? added.job : added;

      await expect(
        cron.add({
          declarationKey: "skill-collection-review:main",
          name: "rogue-collision",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "systemEvent", text: "hijack" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        }),
      ).rejects.toThrow(
        'cron declarationKey namespace "skill-collection-review:" is system-owned; jobs cannot be created with it',
      );
      await expect(
        cron.add(
          {
            declarationKey: "skill-collection-review:main",
            name: "skill-collection-review-main",
            agentId: "main",
            enabled: true,
            schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
            payload: { kind: "skillCollectionReview" },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
          },
          { enabledExplicit: true, systemOwned: true },
        ),
      ).resolves.toMatchObject({ job: { id: job.id } });

      await expect(
        cron.add({
          name: "rogue",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "skillCollectionReview" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        }),
      ).rejects.toThrow(/system-owned/);
      await expect(
        cron.update(job.id, { payload: { kind: "skillCollectionReview" } }),
      ).rejects.toThrow(/system-owned/);
      await expect(cron.update(job.id, { enabled: false })).rejects.toThrow(/system-owned/);
      await expect(cron.remove(job.id)).rejects.toThrow(/system-owned/);

      await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ok: true });
      expect(runSkillCollectionReview).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", abortSignal: expect.any(AbortSignal) }),
      );
    } finally {
      cron.stop();
      await cleanup();
    }
  });

  it("revokes an active skill review before a disabled monitor can write", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const started = createDeferred<AbortSignal>();
    const release = createDeferred();
    const settled = createDeferred();
    const finalWrite = vi.fn();
    const runSkillCollectionReview = vi.fn(
      async ({ abortSignal }: { agentId: string; abortSignal?: AbortSignal }) => {
        if (!abortSignal) {
          throw new Error("skill review cancellation signal missing");
        }
        started.resolve(abortSignal);
        try {
          await release.promise;
          abortSignal.throwIfAborted();
          finalWrite();
          return { status: "ok" as const, summary: "reviewed main" };
        } finally {
          settled.resolve();
        }
      },
    );
    const { cron } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      runSkillCollectionReview,
    });
    const monitor = {
      declarationKey: "skill-collection-review:main",
      name: "skill-collection-review-main",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 7 * 24 * 60 * 60_000 },
      payload: { kind: "skillCollectionReview" as const },
      sessionTarget: "main" as const,
      wakeMode: "next-heartbeat" as const,
    };
    let activeRun: Promise<unknown> | undefined;
    try {
      await cron.start();
      const added = await cron.add(monitor, { enabledExplicit: true, systemOwned: true });
      const job = "job" in added ? added.job : added;
      activeRun = cron.run(job.id, "force");
      const abortSignal = await started.promise;

      await cron.add({ ...monitor, enabled: false }, { enabledExplicit: true, systemOwned: true });

      expect(abortSignal.aborted).toBe(true);
      release.resolve();
      await settled.promise;
      await activeRun;
      expect(finalWrite).not.toHaveBeenCalled();
      expect(cron.getJob(job.id)?.enabled).toBe(false);
    } finally {
      release.resolve();
      await activeRun?.catch(() => undefined);
      cron.stop();
      await cleanup();
    }
  });

  it("keeps failing skill collection reviews enabled", async () => {
    const { storePath, cleanup } = await makeStorePath();
    const runSkillCollectionReview = vi.fn(async () => ({
      status: "error" as const,
      summary: "review failed",
      error: "review failed",
    }));
    const { cron, enqueueSystemEvent } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger: noopLogger,
      runSkillCollectionReview,
    });
    try {
      await cron.start();
      const added = await cron.add(
        {
          declarationKey: "skill-collection-review:main",
          name: "skill-collection-review-main",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 7 * 24 * 60 * 60_000 },
          payload: { kind: "skillCollectionReview" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        { enabledExplicit: true, systemOwned: true },
      );
      const job = "job" in added ? added.job : added;

      for (let attempt = 0; attempt < 11; attempt++) {
        vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
        await expect(cron.run(job.id, "due")).resolves.toMatchObject({ ok: true });
      }

      expect(runSkillCollectionReview).toHaveBeenCalledTimes(11);
      const failedJob = cron.getJob(job.id);
      expect(failedJob).toMatchObject({
        enabled: true,
        state: { lastStatus: "error", lastError: "review failed" },
      });
      expect(failedJob?.state.consecutiveErrors).toBe(11);
      expect(failedJob?.state.autoDisabled).toBeUndefined();
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        expect.stringContaining("auto-disabled"),
        expect.anything(),
      );
    } finally {
      cron.stop();
      await cleanup();
    }
  });
});
