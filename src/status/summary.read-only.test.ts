import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getAgentLocalStatuses } from "../commands/status.agent-local.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { recordDefaultProactiveJobInDatabase } from "../cron/proactive-job-receipt.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { buildHealthAgentSummaries, resolveHealthAgentOrder } from "../gateway/health/collector.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import * as machineState from "../state/config-machine-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getStatusSummary } from "./summary.js";

describe("getStatusSummary read-only session access", () => {
  it.each(["status", "health"])(
    "does not create shared state for a cold legacy %s projection",
    async (surface) => {
      await withOpenClawTestState({ prefix: "status-cold-projection-" }, async (state) => {
        const databasePath = path.join(state.stateDir, "state", "openclaw.sqlite");
        expect(fs.existsSync(databasePath)).toBe(false);
        if (surface === "status") {
          await getStatusSummary({ includeChannelSummary: false, config: {} });
        } else {
          await buildHealthAgentSummaries({}, resolveHealthAgentOrder({}));
        }
        expect(fs.existsSync(databasePath)).toBe(false);
      });
    },
  );
  it.each(["status", "health"])(
    "does not migrate shared state for a legacy %s projection",
    async (surface) => {
      await withOpenClawTestState({ prefix: "status-old-projection-" }, async (state) => {
        const databasePath = state.statePath("state", "openclaw.sqlite");
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const db = new DatabaseSync(databasePath);
        db.exec("PRAGMA user_version = 1");
        db.close();
        const before = fs.readFileSync(databasePath);
        await expect(
          surface === "status"
            ? getStatusSummary({ includeChannelSummary: false, config: {} })
            : buildHealthAgentSummaries({}, resolveHealthAgentOrder({})),
        ).rejects.toThrow("doctor --fix");
        expect(fs.readFileSync(databasePath)).toEqual(before);
      });
    },
  );
  it("does not treat unreadable shared state as an empty store", async () => {
    await withOpenClawTestState({ prefix: "status-unreadable-projection-" }, async (state) => {
      const databasePath = state.statePath("state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(databasePath, "not a SQLite database");
      const before = fs.readFileSync(databasePath);
      await expect(
        getStatusSummary({ includeChannelSummary: false, config: {} }),
      ).rejects.toThrow();
      expect(fs.readFileSync(databasePath)).toEqual(before);
    });
  });

  const previousRegistry = getActivePluginRegistry();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    const telegram = createOutboundTestPlugin({
      id: "telegram",
      outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
      messaging: {
        targetPrefixes: ["telegram"],
        inferTargetChatType: ({ to }) => {
          return /^(?:telegram:)?\d+$/.test(to) ? "direct" : undefined;
        },
      },
    });
    telegram.config = {
      ...telegram.config,
      resolveAllowFrom: ({ cfg }) => cfg.channels?.telegram?.allowFrom ?? [],
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegram, source: "test" }]),
    );
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(() => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
  });

  it.each([
    ["last", false, true],
    ["owner", true, false],
  ] as const)(
    "checks the converted %s route without creating a session database",
    async (target, owner, waitingForRoute) => {
      await withOpenClawTestState({ prefix: "status-legacy-route-" }, async (state) => {
        const databasePath = state.path("sessions", "openclaw-agent.sqlite");
        const storePath = state.path("cron", "jobs.json");
        const config = {
          cron: { enabled: true, store: storePath },
          session: { store: databasePath },
          ...(owner
            ? {
                commands: { ownerAllowFrom: ["telegram:123"] },
                channels: { telegram: { allowFrom: ["123"] } },
              }
            : {}),
        };
        const cron = new CronService({
          storePath,
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          runIsolatedAgentJob: vi.fn(),
        });
        try {
          const job = await cron.add({
            agentId: "main",
            name: "converted",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "session:agent:main:main",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "check" },
            delivery:
              target === "owner"
                ? { mode: "announce", target }
                : { mode: "announce", channel: target },
          });
          recordDefaultProactiveJobInDatabase(
            openOpenClawStateDatabase().db,
            storePath,
            "main",
            job.id,
            1,
          );
          const summary = await getStatusSummary({ includeChannelSummary: false, config });
          expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(waitingForRoute);
          expect(fs.existsSync(databasePath)).toBe(false);
        } finally {
          cron.stop();
        }
      });
    },
  );

  it("preserves raw legacy projections with one read-only snapshot for the whole fleet", async () => {
    await withOpenClawTestState({ prefix: "status-fleet-projection-" }, async (state) => {
      const storePath = state.path("cron", "jobs.json");
      const config = {
        cron: { enabled: true },
        agents: {
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, disabled: {}, event: {} },
        },
      };
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
      });
      try {
        for (const agentId of ["main", "disabled", "event"]) {
          const job = await cron.add({
            agentId,
            name: agentId,
            enabled: agentId !== "disabled",
            schedule:
              agentId === "event"
                ? { kind: "cron", expr: "0 9 * * *" }
                : { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "check" },
            delivery: { mode: "none" },
          });
          if (agentId !== "main") {
            recordDefaultProactiveJobInDatabase(
              openOpenClawStateDatabase().db,
              storePath,
              agentId,
              job.id,
              1,
            );
          }
        }
        machineState.writeConfigMachineState("cron.store", storePath);
        const legacy = ["main", "disabled", "event"].map((id) =>
          resolveHeartbeatSummaryForAgent(config, id),
        );
        closeOpenClawStateDatabaseForTest();
        const databasePath = state.statePath("state", "openclaw.sqlite");
        const before = fs.readFileSync(databasePath);
        const reader = vi.spyOn(stateDatabase, "openExistingOpenClawStateDatabaseReadOnly");
        const machineReader = vi.spyOn(machineState, "readConfigMachineState");
        const writer = vi.spyOn(stateDatabase, "openOpenClawStateDatabase");
        try {
          const status = await getStatusSummary({ config, includeChannelSummary: false });
          expect(reader).toHaveBeenCalledTimes(1);
          const health = await buildHealthAgentSummaries(config, resolveHealthAgentOrder(config));
          expect(reader).toHaveBeenCalledTimes(2);
          expect(writer).not.toHaveBeenCalled();
          expect(machineReader.mock.calls.filter(([key]) => key === "cron.store")).toHaveLength(0);
          expect(health.map((agent) => agent.heartbeat)).toEqual(legacy);
          expect(
            status.heartbeat.agents.map(({ agentId, enabled, every, everyMs }) => ({
              agentId,
              enabled,
              every,
              everyMs,
            })),
          ).toEqual([
            { agentId: "main", enabled: false, every: "disabled", everyMs: null },
            { agentId: "disabled", enabled: false, every: "disabled", everyMs: null },
            { agentId: "event", enabled: true, every: "scheduled", everyMs: null },
          ]);
          expect(await cron.status()).toMatchObject({ enabled: true, jobs: 3 });
          expect(fs.readFileSync(databasePath)).toEqual(before);
        } finally {
          machineReader.mockRestore();
          reader.mockRestore();
          writer.mockRestore();
        }
      } finally {
        cron.stop();
      }
    });
  });

  it.each(["sessions.json", "shared.sqlite"])(
    "reports each agent's activity and reads each physical session store once for %s",
    async (fileName) => {
      const tempDir = tempDirs.make("openclaw-status-session-stores-");
      const storePath = path.join(tempDir, fileName);
      const config = {
        agents: {
          defaults: { systemAgent: { agentId: "main" } },
          list: [{ id: "main", default: true }, { id: "ops" }],
        },
        session: { store: storePath },
      };

      try {
        for (const agentId of ["main", "ops"]) {
          const logicalPath = resolveSessionStorePathCore(config.session.store, { agentId });
          await replaceSessionEntry(
            { agentId, sessionKey: `agent:${agentId}:main`, storePath: logicalPath },
            { sessionId: `${agentId}-session`, updatedAt: agentId === "main" ? 10 : 20 },
          );
        }
        closeOpenClawAgentDatabasesForTest();

        const expectedPaths = ["main", "ops"].map(
          (agentId) => resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path,
        );
        const uniquePaths = [...new Set(expectedPaths)];
        const readSummary = vi.spyOn(sessionAccessor, "readSessionStoreSummaryReadOnly");
        const now = vi.spyOn(Date, "now").mockReturnValue(100);
        try {
          const summary = await getStatusSummary({ includeChannelSummary: false, config });

          expect(summary.sessions.count).toBe(2);
          expect(summary.sessions.paths).toEqual(uniquePaths);
          expect(
            summary.sessions.byAgent.map((agent) => [
              agent.agentId,
              agent.path,
              agent.count,
              agent.recent.map((session) => [session.agentId, session.key]),
            ]),
          ).toEqual([
            ["main", expectedPaths[0], 1, [["main", "agent:main:main"]]],
            ["ops", expectedPaths[1], 1, [["ops", "agent:ops:main"]]],
          ]);
          expect(readSummary).toHaveBeenCalledTimes(uniquePaths.length);

          readSummary.mockClear();
          const local = await getAgentLocalStatuses(config);
          expect(local.totalSessions).toBe(2);
          expect(
            local.agents.map((agent) => [
              agent.id,
              agent.sessionsCount,
              agent.lastUpdatedAt,
              agent.lastActiveAgeMs,
            ]),
          ).toEqual([
            ["main", 1, 10, 90],
            ["ops", 1, 20, 80],
          ]);
          expect(readSummary).toHaveBeenCalledTimes(uniquePaths.length);
          expect(uniquePaths.every((databasePath) => fs.existsSync(databasePath))).toBe(true);
        } finally {
          readSummary.mockRestore();
          now.mockRestore();
        }
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );

  it("does not reread ambient config while projecting prepared session runtime state", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-status-prepared-config-", layout: "split" },
      async (state) => {
        const storePath = state.path("sessions.json");
        const config = { session: { store: storePath } };
        await state.writeConfig({ session: {} });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: "agent:main:main", storePath },
          { sessionId: "prepared-config", updatedAt: 10 },
        );
        closeOpenClawAgentDatabasesForTest();
        clearRuntimeConfigSnapshot();
        const readFileSync = vi.spyOn(fs, "readFileSync");
        try {
          await getStatusSummary({ includeChannelSummary: false, config });
          expect(
            readFileSync.mock.calls.filter(([file]) => file === state.configPath),
          ).toHaveLength(0);
        } finally {
          readFileSync.mockRestore();
        }
      },
    );
  });

  it("bounds session payload hydration to the recent status window", async () => {
    await withOpenClawTestState({ prefix: "openclaw-status-recent-window-" }, async (state) => {
      const config = {
        agents: { defaults: { heartbeat: { every: "0m" } }, entries: { main: {} } },
      };
      const storePath = resolveSessionStorePathCore(undefined, {
        agentId: "main",
        env: state.env,
      });
      for (let index = 1; index <= 24; index += 1) {
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: `agent:main:history-${index}` },
          {
            sessionId: `status-history-${index}`,
            updatedAt: index,
            pluginExtensions: {
              fixture: { history: Array.from({ length: 64 }, () => "x".repeat(128)) },
            },
          },
        );
      }
      await getStatusSummary({ config, includeChannelSummary: false });
      const clone = vi.spyOn(globalThis, "structuredClone");
      const parse = vi.spyOn(JSON, "parse");
      const parsedSessionPayloads = () =>
        parse.mock.calls.filter(([json]) => json.includes('"sessionId":"status-history-'));
      try {
        const summary = await getStatusSummary({ config, includeChannelSummary: false });

        expect(parsedSessionPayloads()).toHaveLength(10);
        expect(summary.sessions.count).toBe(24);
        expect(summary.sessions.byAgent[0]?.count).toBe(24);
        expect(summary.sessions.recent.map(({ key }) => key)).toEqual(
          Array.from({ length: 10 }, (_, index) => `agent:main:history-${24 - index}`),
        );
        expect(
          clone.mock.calls.filter(([value]) => {
            const sessionId = (value as { sessionId?: unknown })?.sessionId;
            return typeof sessionId === "string" && sessionId.startsWith("status-history-");
          }),
        ).toHaveLength(0);

        parse.mockClear();
        const hidden = await getStatusSummary({
          config,
          includeChannelSummary: false,
          includeSensitive: false,
        });
        expect(hidden.sessions.count).toBe(24);
        expect(parsedSessionPayloads()).toHaveLength(0);
      } finally {
        parse.mockRestore();
        clone.mockRestore();
      }
    });
  });
});
