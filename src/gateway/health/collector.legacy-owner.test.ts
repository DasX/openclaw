import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { recordDefaultProactiveJobInDatabase } from "../../cron/proactive-job-receipt.js";
import { resolveCronJobsStorePathFromConfig, saveCronJobsStore } from "../../cron/store.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

let testConfig: OpenClawConfig = {};
let healthPluginsForTest: ChannelPlugin[] = [];
const tempDirs = createTempDirTracker();
let sessionStorePath: string;
let state: OpenClawTestState;

let collectGatewayHealthSnapshot: typeof import("./collector.js").collectGatewayHealthSnapshot;
let createChannelTestPluginBase: typeof import("../../test-utils/channel-plugins.js").createChannelTestPluginBase;

function createHealthPlugin(): ChannelPlugin {
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null) => ({
    accountId: accountId?.trim() || "default",
    enabled: true,
    configured: true,
  });
  return {
    ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
    config: {
      listAccountIds: (cfg) => {
        const telegram = cfg.channels?.telegram as
          | { accounts?: Record<string, unknown> }
          | undefined;
        const accountIds = Object.keys(telegram?.accounts ?? {});
        return accountIds.length > 0 ? accountIds : ["default"];
      },
      resolveAccount,
      inspectAccount: resolveAccount,
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
    },
    status: {
      buildChannelSummary: ({ snapshot }) => ({
        accountId: snapshot.accountId,
        configured: snapshot.configured,
      }),
    },
  };
}

describe("collectGatewayHealthSnapshot legacy owner projection", () => {
  beforeAll(async () => {
    vi.doMock("../../config/config.js", () => ({
      getRuntimeConfig: () => testConfig,
    }));
    // Store paths reach real SQLite target resolution, which inspects the agent
    // database beside them; a shared /tmp path would read machine-wide state.
    vi.doMock("../../config/sessions/paths.js", () => ({
      resolveSessionStorePathCore: () => sessionStorePath,
    }));
    vi.doMock("../../config/sessions/session-accessor.js", () => ({
      readSessionStoreSummaryReadOnly: () => ({ count: 0, recent: [], byAgent: new Map() }),
    }));
    vi.doMock("../../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig: () => healthPluginsForTest,
    }));

    const [health, channelTestUtils] = await Promise.all([
      import("./collector.js"),
      import("../../test-utils/channel-plugins.js"),
    ]);
    collectGatewayHealthSnapshot = health.collectGatewayHealthSnapshot;
    createChannelTestPluginBase = channelTestUtils.createChannelTestPluginBase;
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "health-legacy-jobs-" });
    sessionStorePath = path.join(
      tempDirs.make("openclaw-health-legacy-sessions-"),
      "sessions.json",
    );
    healthPluginsForTest = [createHealthPlugin()];
  });

  afterEach(async () => {
    await state.cleanup();
    tempDirs.cleanup();
  });

  it("projects the retained owner without inventing an explicit fleet default", async () => {
    const migratedConfig = {
      agents: {
        entries: { first: {}, ops: {}, research: {} },
      },
      bindings: [{ agentId: "ops", match: { channel: "telegram", accountId: "ops" } }],
      channels: {
        telegram: {
          accounts: {
            default: { botToken: "default-token" },
            ops: { botToken: "ops-token" },
          },
        },
      },
    } satisfies OpenClawConfig;
    testConfig = retainLegacyDefaultAgentId(migratedConfig, "ops");

    const migrated = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(migrated.defaultAgentId).toBe("ops");
    expect(migrated.agents.map(({ sessions }) => path.dirname(sessions.path))).toEqual(
      migrated.agents.map(() => path.dirname(sessionStorePath)),
    );
    const migratedOwner = migrated.agents.find((agent) => agent.isDefault);
    expect(migratedOwner?.agentId).toBe("ops");
    expect(migratedOwner?.heartbeat.enabled).toBe(false);
    expect(migrated.agents.find((agent) => agent.agentId === "first")?.heartbeat.enabled).toBe(
      false,
    );
    expect(migrated.heartbeatSeconds).toBe((migratedOwner?.heartbeat.everyMs ?? 0) / 1000);
    expect(migrated.channels.telegram?.accountId).toBe("ops");

    testConfig = {
      agents: {
        ownership: "explicit",
        entries: { first: {}, ops: {}, research: {} },
      },
    };

    const explicit = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });

    expect(explicit.defaultAgentId).toBeUndefined();
    expect(explicit.agents.every((agent) => !agent.isDefault)).toBe(true);
    expect(explicit.agents.every((agent) => !agent.heartbeat.enabled)).toBe(true);
    expect(explicit.heartbeatSeconds).toBe(0);
  });

  it.each([true, false])(
    "reports converted job cadence independently of another job enabled=%s",
    async (enabled) => {
      testConfig = {
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      };
      const storePath = resolveCronJobsStorePathFromConfig(testConfig);
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [
          makeCronJob({ id: "converted-ops", agentId: "ops", enabled, delivery: { mode: "none" } }),
          makeCronJob({
            id: "converted-research",
            agentId: "research",
            schedule: { kind: "every", everyMs: 300_000 },
            delivery: { mode: "none" },
          }),
        ],
      });
      for (const agentId of ["ops", "research"]) {
        recordDefaultProactiveJobInDatabase(
          openOpenClawStateDatabase().db,
          storePath,
          agentId,
          `converted-${agentId}`,
          1,
        );
      }

      const health = await collectGatewayHealthSnapshot({ audience: "admin", probe: false });
      expect(health.agents.map((agent) => agent.agentId)).toEqual(["ops", "research"]);
      expect(health.agents.map((agent) => agent.heartbeat.enabled)).toEqual([enabled, true]);
      expect(health.heartbeatSeconds).toBe(enabled ? 60 : 300);
    },
  );
});
