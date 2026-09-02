import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  provisionDefaultProactiveJob,
  readDefaultProactiveJobReceiptInDatabase,
} from "../cron/default-proactive-job.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { createCronServiceState } from "../cron/service/state.js";
import { isRunnableJob } from "../cron/service/timer-runnable.js";
import {
  loadCronJobsStore,
  loadCronJobsStoreWithConfigJobsReadOnly,
  saveCronJobsStore,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import type { CronStoredJob } from "../cron/types.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  ensureHeartbeatMonitorJobs,
  collectHeartbeatCadenceMigrationFindings,
  maybeMigrateHeartbeatCadenceToCron,
} from "./doctor-heartbeat-cadence-migration.js";
import { retireHeartbeatWithDoctor } from "./doctor-heartbeat-retirement.js";
import { resolveHeartbeatPhaseMs } from "./doctor-heartbeat-schedule.js";

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalStateDir: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture(every = "15m") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-cadence-"));
  tempDirs.push(root);
  process.env.HOME = path.join(root, "home");
  process.env.OPENCLAW_STATE_DIR = root;
  const env = process.env;
  const cfg = {
    agents: {
      defaults: { heartbeat: { every } },
      list: [{ id: "main" }],
    },
  } as OpenClawConfig;
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  return { cfg, env, storePath };
}

// Seed the shipped storage shape, not a newly authored retired payload.
async function saveLegacyMonitor(storePath: string, ...legacyJobs: CronStoredJob[]) {
  await saveCronJobsStore(storePath, {
    version: 1,
    jobs: legacyJobs.map((legacy) => ({
      ...legacy,
      payload: { ...legacy.payload, kind: "systemEvent", text: "legacy fixture" },
    })),
  });
  const { db } = openOpenClawStateDatabase();
  for (const legacy of legacyJobs) {
    const row = loadCronRows(db, cronStoreKey(storePath)).find(
      (entry) => entry.job_id === legacy.id,
    )!;
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .updateTable("cron_jobs")
        .set({
          payload_kind: "heartbeat",
          job_json: JSON.stringify({ ...JSON.parse(row.job_json), payload: legacy.payload }),
        })
        .where("store_key", "=", cronStoreKey(storePath))
        .where("job_id", "=", legacy.id),
    );
  }
}

async function loadMonitor(
  storePath: string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { store } = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env);
  return store.jobs.find((job) => job.agentId === agentId && job.payload.kind === "agentTurn");
}

async function loadMainMonitor(storePath: string) {
  return loadMonitor(storePath, "main");
}

describe("heartbeat cadence cron migration", () => {
  it("commits imported scratch before returning config without retired inputs", async () => {
    const fixture = await createFixture();
    const workspace = path.join(fixture.env.OPENCLAW_STATE_DIR!, "workspace");
    fixture.cfg.agents!.defaults!.workspace = workspace;
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "HEARTBEAT.md"), "Check the backup.\n");
    const retired = await retireHeartbeatWithDoctor(fixture.cfg, fixture.env);
    const job = await loadMainMonitor(fixture.storePath);
    const { readCronJobScratchState } = await import("../cron/scratch-store.js");
    expect(readCronJobScratchState(fixture.storePath, job!.id).scratch?.content).toBe(
      "Check the backup.\n",
    );
    expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
    expect(fixture.cfg.agents?.defaults?.heartbeat?.every).toBe("15m");
    await expect(fs.access(path.join(workspace, "HEARTBEAT.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await retireHeartbeatWithDoctor(retired, fixture.env);
    expect((await loadCronJobsStore(fixture.storePath)).jobs.map((entry) => entry.id)).toEqual([
      job!.id,
    ]);
  });

  it("retains the legacy source and config when a scratch tombstone blocks conversion", async () => {
    const fixture = await createFixture();
    const workspace = path.join(fixture.env.OPENCLAW_STATE_DIR!, "workspace");
    fixture.cfg.agents!.defaults!.workspace = workspace;
    await fs.mkdir(workspace, { recursive: true });
    const source = path.join(workspace, "HEARTBEAT.md");
    await fs.writeFile(source, "Do not discard this instruction.\n");
    const jobs = await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    const { writeCronJobScratch, readCronJobScratchState } =
      await import("../cron/scratch-store.js");
    expect(
      writeCronJobScratch({
        storePath: fixture.storePath,
        jobId: jobs.get("main")!.id,
        content: null,
        expectedRevision: 0,
      }),
    ).toEqual({ ok: true, currentRevision: 1 });
    await expect(retireHeartbeatWithDoctor(fixture.cfg, fixture.env)).rejects.toThrow(
      "explicitly unset",
    );
    expect(await fs.readFile(source, "utf8")).toBe("Do not discard this instruction.\n");
    expect(fixture.cfg.agents?.defaults?.heartbeat?.every).toBe("15m");
    expect(readCronJobScratchState(fixture.storePath, jobs.get("main")!.id)).toEqual({
      currentRevision: 1,
    });
  });

  it("fences pending migration from natural and forced runs without rewriting saved job state", async () => {
    const fixture = await createFixture();
    const jobs = await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    const job = jobs.get("main")!;
    const runSessionEvent = vi.fn().mockResolvedValue({ status: "ok", executionStarted: true });
    const deps = {
      storePath: fixture.storePath,
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      runSessionEvent,
      isExecutionIdle: () => true,
    };
    const state = createCronServiceState(deps);
    expect(isRunnableJob({ state, job, nowMs: job.state.nextRunAtMs! + 1 })).toBe(false);
    const cron = new CronService(deps);
    try {
      await expect(cron.run(job.id, "force")).rejects.toThrow("migration is incomplete");
      expect(runSessionEvent).not.toHaveBeenCalled();
      expect(await loadMainMonitor(fixture.storePath)).toEqual(job);
      await retireHeartbeatWithDoctor(fixture.cfg, fixture.env);
      await expect(cron.run(job.id, "force")).resolves.toMatchObject({ ran: true });
      expect(runSessionEvent).toHaveBeenCalledOnce();
    } finally {
      cron.stop();
    }
  });

  it("does not invent an owner for an explicit multi-agent roster", async () => {
    const fixture = await createFixture();
    fixture.cfg.agents = { ownership: "explicit", entries: { main: {}, ops: {} } };
    const jobs = await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    expect(jobs.size).toBe(0);
    expect((await loadCronJobsStore(fixture.storePath)).jobs).toEqual([]);
  });

  it("does not adopt a user job with a colliding former monitor declaration", async () => {
    const fixture = await createFixture();
    const userJob = {
      id: "user-owned",
      name: "User reminder",
      agentId: "main",
      declarationKey: "heartbeat:main",
      createdAtMs: 1,
      updatedAtMs: 1,
      enabled: true,
      schedule: { kind: "every" as const, everyMs: 60000, anchorMs: 1 },
      sessionTarget: "main" as const,
      wakeMode: "now" as const,
      payload: { kind: "systemEvent" as const, text: "User-owned reminder" },
      state: {},
    };
    await saveCronJobsStore(fixture.storePath, { version: 1, jobs: [userJob] });
    const jobs = await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    expect(jobs.get("main")?.id).not.toBe(userJob.id);
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.find((job) => job.id === userJob.id),
    ).toEqual(userJob);
  });

  it("previews without writes and provisions an ordinary editable job only once", async () => {
    const fixture = await createFixture();
    expect(await collectHeartbeatCadenceMigrationFindings(fixture.cfg, fixture.env)).toEqual([
      expect.objectContaining({ requirement: "heartbeat-retirement" }),
    ]);
    await maybeMigrateHeartbeatCadenceToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: false,
    });
    await expect(fs.access(resolveOpenClawStateSqlitePath(fixture.env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const jobs = await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    const created = jobs.get("main")!;
    expect(created).toMatchObject({
      enabled: true,
      schedule: { kind: "every", everyMs: 15 * 60_000 },
      payload: { kind: "agentTurn", skipIfScratchEmpty: true },
      delivery: { mode: "announce", target: "owner" },
      idleOnly: true,
    });
    expect(created.declarationKey).toBeUndefined();
    expect(created.sessionTarget).toBe("session:agent:main:main");
    await retireHeartbeatWithDoctor(fixture.cfg, fixture.env);
    const edited = { ...created, enabled: false, name: "My own check" };
    await saveCronJobsStore(fixture.storePath, { version: 1, jobs: [edited] });
    expect(
      (await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env)).get("main"),
    ).toEqual(edited);
    await saveCronJobsStore(fixture.storePath, { version: 1, jobs: [] });
    expect(
      (await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env)).size,
    ).toBe(0);
    expect((await loadCronJobsStore(fixture.storePath)).jobs).toEqual([]);
    expect(await collectHeartbeatCadenceMigrationFindings(fixture.cfg, fixture.env)).toEqual([]);
  });

  it("transfers an unexecuted legacy one-shot retry to the ordinary catch-up owner without changing history", async () => {
    const fixture = await createFixture();
    const job = {
      id: "pending-reminder",
      name: "pending reminder",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: "at" as const, at: "2026-01-01T00:00:00.000Z" },
      sessionTarget: "main" as const,
      wakeMode: "now" as const,
      payload: { kind: "systemEvent" as const, text: "reminder" },
      state: {
        lastRunAtMs: 10,
        nextRunAtMs: 20,
        lastRunStatus: "skipped" as const,
        lastError: "disabled",
        consecutiveSkipped: 1,
      },
    };
    await saveCronJobsStore(fixture.storePath, { version: 1, jobs: [job] });
    await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    const first = (await loadCronJobsStore(fixture.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    )!;
    expect(first).toMatchObject({ ...job, state: { ...job.state, startupCatchupAtMs: 20 } });
    const state = createCronServiceState({
      storePath: fixture.storePath,
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    expect(isRunnableJob({ state, job: first, nowMs: 20, skipAtIfAlreadyRan: true })).toBe(true);
    await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.find((entry) => entry.id === job.id),
    ).toEqual(first);
  });

  it("preserves disabled cadence and serializes concurrent provisioning", async () => {
    const fixture = await createFixture("0m");
    const results = await Promise.all([
      ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env),
      ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env),
    ]);
    expect(results[0].get("main")?.id).toBe(results[1].get("main")?.id);
    expect((await loadCronJobsStore(fixture.storePath)).jobs).toHaveLength(1);
    expect(await loadMainMonitor(fixture.storePath)).toMatchObject({ enabled: false });
  });

  it.each([
    { every: "37m", source: "defaults", everyMs: 2_220_000, enabled: true },
    { every: "0m", source: "defaults", everyMs: 1_800_000, enabled: false },
    { every: "37m", source: "agent override", everyMs: 2_220_000, enabled: true },
    { every: "0m", source: "agent override", everyMs: 1_800_000, enabled: false },
  ])(
    "transfers effective $every from $source before removing config",
    async ({ every, source, everyMs, enabled }) => {
      const fixture = await createFixture(source === "defaults" ? every : "11m");
      if (source === "agent override") {
        fixture.cfg.agents!.entries = { main: { heartbeat: { every } } };
        delete fixture.cfg.agents!.list;
      }
      const nowMs = Date.parse("2026-01-01T12:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(nowMs);
      const legacy: CronStoredJob = {
        id: "generated-monitor",
        agentId: "main",
        declarationKey: "heartbeat:main",
        name: "Heartbeat",
        enabled: true,
        createdAtMs: 10,
        updatedAtMs: 20,
        schedule: { kind: "every", everyMs: 1_800_000, anchorMs: 37 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "heartbeat", toolsAllow: ["read"], toolsAllowIsDefault: false },
        runtimeAuthority: {
          version: 1,
          runtimeId: "fixture-runtime",
          namespace: "fixture-authority",
          payload: { binding: "unchanged" },
        },
        state: {
          lastRunAtMs: nowMs - 3_600_000,
          lastRunStatus: "ok",
          nextRunAtMs: nowMs - 1,
          queuedAtMs: nowMs - 1,
          startupCatchupAtMs: nowMs - 1,
          pacedNextRunAtMs: nowMs - 1,
          forcePreservedNextRunAtMs: nowMs - 1,
        },
      };
      await saveLegacyMonitor(fixture.storePath, legacy);
      const { writeCronJobScratch, readCronJobScratchState } =
        await import("../cron/scratch-store.js");
      writeCronJobScratch({
        storePath: fixture.storePath,
        jobId: legacy.id,
        content: "Check backup.\n",
        expectedRevision: 0,
      });
      const scratch = readCronJobScratchState(fixture.storePath, legacy.id);
      const retired = await retireHeartbeatWithDoctor(fixture.cfg, fixture.env);
      expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
      expect(retired.agents?.entries?.main?.heartbeat).toBeUndefined();
      closeOpenClawStateDatabaseForTest();
      const converted = (await loadCronJobsStore(fixture.storePath)).jobs.find(
        (job) => job.id === legacy.id,
      )!;
      expect(converted).toMatchObject({
        enabled,
        schedule: { kind: "every", everyMs },
        createdAtMs: legacy.createdAtMs,
        runtimeAuthority: legacy.runtimeAuthority,
        payload: { kind: "agentTurn", toolsAllow: ["read"], toolsAllowIsDefault: false },
        state: {
          lastRunAtMs: legacy.state.lastRunAtMs,
          lastRunStatus: "ok",
          scheduleActivatedAtMs: nowMs,
        },
      });
      expect(converted.declarationKey).toBeUndefined();
      expect(readCronJobScratchState(fixture.storePath, legacy.id)).toEqual(scratch);
      expect(converted.state.queuedAtMs).toBeUndefined();
      expect(converted.state.startupCatchupAtMs).toBeUndefined();
      expect(converted.state.pacedNextRunAtMs).toBeUndefined();
      expect(converted.state.forcePreservedNextRunAtMs).toBeUndefined();
      if (enabled) {
        const schedulerSeed = loadOrCreateDeviceIdentity({ env: fixture.env }).deviceId;
        expect(converted.schedule).toEqual({
          kind: "every",
          everyMs,
          anchorMs: resolveHeartbeatPhaseMs({
            schedulerSeed,
            agentId: "main",
            intervalMs: everyMs,
          }),
        });
        expect(converted.state.nextRunAtMs).toBeGreaterThan(nowMs);
      } else {
        expect(converted.schedule).toEqual(legacy.schedule);
        expect(converted.state.nextRunAtMs).toBeUndefined();
      }
      await retireHeartbeatWithDoctor(retired, fixture.env);
      expect(
        (await loadCronJobsStore(fixture.storePath)).jobs.find((job) => job.id === legacy.id),
      ).toEqual(converted);
    },
  );

  it("retains config and rows when a generated declaration conflicts with its agent", async () => {
    const fixture = await createFixture("37m");
    await saveLegacyMonitor(fixture.storePath, {
      id: "conflicting-monitor",
      agentId: "main",
      declarationKey: "heartbeat:other",
      name: "Conflicting monitor",
      enabled: true,
      createdAtMs: 10,
      updatedAtMs: 20,
      schedule: { kind: "every", everyMs: 1_800_000, anchorMs: 37 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "heartbeat" },
      state: { nextRunAtMs: 123456 },
    });
    const before = (await loadCronJobsStoreWithConfigJobsReadOnly(fixture.storePath, fixture.env))
      .store;
    await expect(retireHeartbeatWithDoctor(fixture.cfg, fixture.env)).rejects.toThrow(
      "conflicting declaration",
    );
    expect(fixture.cfg.agents?.defaults?.heartbeat?.every).toBe("37m");
    expect(
      (await loadCronJobsStoreWithConfigJobsReadOnly(fixture.storePath, fixture.env)).store,
    ).toEqual(before);
    expect(
      readDefaultProactiveJobReceiptInDatabase(
        openOpenClawStateDatabase().db,
        fixture.storePath,
        "main",
      ),
    ).toBeUndefined();
  });

  it.each([
    {
      label: "disabled generated monitor",
      declarationKey: "heartbeat:main",
      enabled: false,
      autoDisabled: false,
    },
    {
      label: "unchanged generated cadence",
      declarationKey: "heartbeat:main",
      enabled: true,
      autoDisabled: false,
    },
    {
      label: "auto-disabled generated monitor",
      declarationKey: "heartbeat:main",
      enabled: false,
      autoDisabled: true,
    },
    {
      label: "independent enabled row",
      declarationKey: undefined,
      enabled: true,
      autoDisabled: false,
    },
    {
      label: "independent disabled row",
      declarationKey: "operator:check",
      enabled: false,
      autoDisabled: false,
    },
    {
      label: "independent auto-disabled row",
      declarationKey: undefined,
      enabled: false,
      autoDisabled: true,
    },
  ])(
    "converts $label without replacing identity, scheduling state, or scratch tombstones",
    async ({ declarationKey, enabled, autoDisabled }) => {
      const generated = declarationKey === "heartbeat:main";
      const fixture = await createFixture(generated ? "15m" : "37m");
      const { writeCronJobScratch, readCronJobScratchState } =
        await import("../cron/scratch-store.js");
      const legacy = {
        id: "preserved",
        agentId: "main",
        ...(declarationKey ? { declarationKey } : {}),
        name: "User label",
        enabled,
        createdAtMs: 10,
        updatedAtMs: 20,
        schedule: { kind: "every" as const, everyMs: 900000, anchorMs: 37 },
        sessionTarget: "main" as const,
        wakeMode: "next-heartbeat" as const,
        payload: { kind: "heartbeat" as const },
        state: {
          nextRunAtMs: 123456,
          lastRunAtMs: 111111,
          lastRunStatus: "ok" as const,
          queuedAtMs: 123456,
          ...(autoDisabled
            ? {
                autoDisabled: {
                  reason: "consecutive-failures" as const,
                  consecutiveErrors: 10,
                  atMs: 111112,
                },
              }
            : {}),
        },
      };
      const generatedCompanion = {
        ...legacy,
        id: "generated-companion",
        declarationKey: "heartbeat:main",
        enabled: true,
        state: {},
      };
      await saveLegacyMonitor(
        fixture.storePath,
        legacy,
        ...(!generated ? [generatedCompanion] : []),
      );
      writeCronJobScratch({
        storePath: fixture.storePath,
        jobId: legacy.id,
        content: "keep bytes\n",
        expectedRevision: 0,
      });
      const scratch = readCronJobScratchState(fixture.storePath, legacy.id);
      const monitors = await ensureHeartbeatMonitorJobs(
        fixture.cfg,
        fixture.storePath,
        fixture.env,
      );
      const converted = await loadMainMonitor(fixture.storePath);
      expect(converted).toMatchObject({
        id: legacy.id,
        name: legacy.name,
        enabled,
        schedule: legacy.schedule,
        state: legacy.state,
      });
      if (!generated) {
        expect(monitors.get("main")?.id).not.toBe(legacy.id);
        expect(monitors.get("main")?.id).toBe(generatedCompanion.id);
        expect(monitors.get("main")?.schedule).toMatchObject({ everyMs: 2_220_000 });
        expect(converted?.declarationKey).toBe(declarationKey);
        const state = createCronServiceState({
          storePath: fixture.storePath,
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          runIsolatedAgentJob: vi.fn(),
          isExecutionIdle: () => true,
        });
        expect(isRunnableJob({ state, job: converted!, nowMs: 123457 })).toBe(false);
      }
      expect(converted?.payload.kind).toBe("agentTurn");
      expect(readCronJobScratchState(fixture.storePath, legacy.id)).toEqual(scratch);
      writeCronJobScratch({
        storePath: fixture.storePath,
        jobId: legacy.id,
        content: null,
        expectedRevision: scratch.currentRevision,
      });
      const tombstone = readCronJobScratchState(fixture.storePath, legacy.id);
      await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
      expect(readCronJobScratchState(fixture.storePath, legacy.id)).toEqual(tombstone);
      await retireHeartbeatWithDoctor(fixture.cfg, fixture.env);
      closeOpenClawStateDatabaseForTest();
      expect(
        (await loadCronJobsStore(fixture.storePath)).jobs.find((job) => job.id === legacy.id),
      ).toEqual(converted);
    },
  );

  it("does not recreate a deleted partial migration or classify it as completed", async () => {
    const fixture = await createFixture();
    const jobs = await ensureHeartbeatMonitorJobs(fixture.cfg, fixture.storePath, fixture.env);
    const receipt = () =>
      readDefaultProactiveJobReceiptInDatabase(
        openOpenClawStateDatabase({ env: fixture.env }).db,
        fixture.storePath,
        "main",
      );
    expect(receipt()).toMatchObject({ jobId: jobs.get("main")!.id, phase: "pending" });
    await saveCronJobsStore(fixture.storePath, { version: 1, jobs: [] });
    await expect(retireHeartbeatWithDoctor(fixture.cfg, fixture.env)).rejects.toThrow(
      "incomplete cutover",
    );
    expect((await loadCronJobsStore(fixture.storePath)).jobs).toEqual([]);
    expect(receipt()?.phase).toBe("pending");
  });

  it.each([
    ["oauth", 3_600_000],
    ["token", 3_600_000],
    ["api_key", 1_800_000],
  ] as const)(
    "provisions the provider-owned %s cadence through the setup owner",
    async (mode, everyMs) => {
      const fixture = await createFixture();
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { model: "anthropic/claude-sonnet-4-6" } },
        auth: { profiles: { fixture: { provider: "anthropic", mode } } },
      };
      const job = provisionDefaultProactiveJob(cfg, "main", { env: fixture.env });
      expect(job?.schedule).toMatchObject({ kind: "every", everyMs });
      expect((await loadCronJobsStore(fixture.storePath)).jobs).toMatchObject([
        { id: job!.id, schedule: { everyMs } },
      ]);
      expect(cfg.agents!.defaults).not.toHaveProperty("heartbeat");
    },
  );

  it("provisions only the fresh ambient owner and honors durable deletion", async () => {
    const fixture = await createFixture();
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const job = provisionDefaultProactiveJob(cfg, "main", {
      env: fixture.env,
      cadenceMs: 3_600_000,
    });
    expect(job?.schedule).toMatchObject({ kind: "every", everyMs: 3_600_000 });
    cfg.agents!.entries!.aux = {};
    cfg.agents!.defaults = { systemAgent: { agentId: "main" } };
    expect(provisionDefaultProactiveJob(cfg, "aux", { env: fixture.env })).toBeUndefined();
    await saveCronJobsStore(fixture.storePath, { version: 1, jobs: [] });
    expect(provisionDefaultProactiveJob(cfg, "main", { env: fixture.env })).toBeUndefined();
    await retireHeartbeatWithDoctor(cfg, fixture.env);
    expect((await loadCronJobsStore(fixture.storePath)).jobs).toEqual([]);
  });

  it("preserves current authority and tool caps across conversion and reopen", async () => {
    const fixture = await createFixture();
    const authority = {
      version: 1 as const,
      runtimeId: "fixture-runtime",
      namespace: "fixture-authority",
      payload: { binding: "unchanged" },
    };
    const legacy: CronStoredJob = {
      id: "authority-monitor",
      agentId: "main",
      name: "Authorized monitor",
      enabled: false,
      createdAtMs: 10,
      updatedAtMs: 20,
      schedule: { kind: "every", everyMs: 900000, anchorMs: 37 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "heartbeat", toolsAllow: ["read"], toolsAllowIsDefault: false },
      runtimeAuthority: authority,
      state: { nextRunAtMs: 123456, queuedAtMs: 123456 },
    };
    await saveLegacyMonitor(fixture.storePath, legacy);
    await retireHeartbeatWithDoctor(fixture.cfg, fixture.env);
    closeOpenClawStateDatabaseForTest();
    const stored = (await loadCronJobsStore(fixture.storePath)).jobs[0]!;
    expect(stored).toMatchObject({
      id: legacy.id,
      runtimeAuthority: authority,
      payload: { kind: "agentTurn", toolsAllow: ["read"], toolsAllowIsDefault: false },
      state: legacy.state,
    });
    expect(stored.runtimeAuthorityRecoveryRequired).toBeUndefined();
  });

  it("removes only retired visibility and preserves plugin transport heartbeat", async () => {
    const fixture = await createFixture();
    fixture.cfg.channels = {
      defaults: { heartbeatVisibility: { showAlerts: false } },
      fixture: {
        heartbeat: { intervalMs: 7500 },
        accounts: { primary: { heartbeat: { transportPing: true } } },
      },
    };
    const next = await retireHeartbeatWithDoctor(fixture.cfg, fixture.env);
    expect(next.channels?.defaults?.heartbeatVisibility).toBeUndefined();
    expect(next.channels?.fixture).toEqual(fixture.cfg.channels.fixture);
    expect((await loadMainMonitor(fixture.storePath))?.delivery?.mode).toBe("none");
  });

  it("uses the supplied environment for the writable scheduler seed", async () => {
    const ambientRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-heartbeat-cadence-ambient-"),
    );
    const suppliedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-heartbeat-cadence-supplied-"),
    );
    tempDirs.push(ambientRoot, suppliedRoot);
    process.env.HOME = path.join(ambientRoot, "home");
    process.env.OPENCLAW_STATE_DIR = ambientRoot;
    const ambientEnv = { ...process.env };
    const suppliedEnv = {
      ...process.env,
      HOME: path.join(suppliedRoot, "home"),
      OPENCLAW_STATE_DIR: suppliedRoot,
    };
    const ambientIdentity = loadOrCreateDeviceIdentity({ env: ambientEnv });
    const suppliedIdentity = loadOrCreateDeviceIdentity({ env: suppliedEnv });
    const intervalMs = 15 * 60_000;
    const agentId = ["main", "ops", "alpha", "beta"].find(
      (candidate) =>
        resolveHeartbeatPhaseMs({
          schedulerSeed: ambientIdentity.deviceId,
          agentId: candidate,
          intervalMs,
        }) !==
        resolveHeartbeatPhaseMs({
          schedulerSeed: suppliedIdentity.deviceId,
          agentId: candidate,
          intervalMs,
        }),
    );
    if (!agentId) {
      throw new Error("expected ambient and supplied identities to produce a distinct phase");
    }
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "15m" } },
        list: [{ id: agentId }],
      },
    } as OpenClawConfig;
    const storePath = resolveCronJobsStorePathFromConfig(cfg, suppliedEnv);

    const result = await maybeMigrateHeartbeatCadenceToCron({
      cfg,
      shouldRepair: true,
      env: suppliedEnv,
    });

    expect(result.warnings).toEqual([]);
    const monitor = await loadMonitor(storePath, agentId, suppliedEnv);
    expect(
      (
        await loadCronJobsStoreWithConfigJobsReadOnly(
          resolveCronJobsStorePathFromConfig(cfg, ambientEnv),
          ambientEnv,
        )
      ).store.jobs,
    ).toEqual([]);
    expect(monitor?.schedule).toEqual(
      expect.objectContaining({
        kind: "every",
        everyMs: intervalMs,
        anchorMs: resolveHeartbeatPhaseMs({
          schedulerSeed: suppliedIdentity.deviceId,
          agentId,
          intervalMs,
        }),
      }),
    );
  });
});
