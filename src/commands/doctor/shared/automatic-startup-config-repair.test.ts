import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createConfigIoContext } from "../../../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../../../config/io.snapshot.js";
import {
  collectEnvSecretRefIds,
  createConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "../../../config/resolution-facts.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { VERSION } from "../../../version.js";
import {
  isStartupConfigRepairResult,
  planAutomaticConfigRepair,
  resolveStartupConfigSnapshot,
} from "./automatic-startup-config-repair.js";

function invalidSnapshot(params: {
  config: OpenClawConfig;
  issuePaths: string[];
  includedPaths?: string[];
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    includedPaths: params.includedPaths ?? [],
    exists: true,
    raw: JSON.stringify(params.config),
    parsed: params.config,
    sourceConfig: params.config,
    resolved: params.config,
    valid: false,
    runtimeConfig: params.config,
    config: params.config,
    issues: params.issuePaths.map((issuePath) => ({ path: issuePath, message: "retired" })),
    warnings: [],
    legacyIssues: [{ path: "", message: "retired" }],
  };
}

describe("automatic startup config repair", () => {
  it("plans a deterministic, fully valid migration of retired session keys", () => {
    const snapshot = invalidSnapshot({
      config: { session: { idleMinutes: 45 } } as OpenClawConfig,
      issuePaths: ["session.idleMinutes"],
    });

    const plan = planAutomaticConfigRepair(snapshot);

    expect(plan?.config.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(validateConfigObjectWithPlugins(plan?.config).ok).toBe(true);
    expect(planAutomaticConfigRepair(snapshot)?.config).toEqual(plan?.config);
    expect(snapshot.sourceConfig.session).toEqual({ idleMinutes: 45 });
  });

  it("plans removal of the stable-authored retired keys without changing other config", () => {
    const snapshot = invalidSnapshot({
      config: {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true, every: "30m" } },
          entries: { main: {} },
        },
        gateway: { mode: "local" },
      } as OpenClawConfig,
      issuePaths: ["meta", "agents.defaults.heartbeat"],
    });

    const plan = planAutomaticConfigRepair(snapshot);

    expect(plan?.config).toEqual({
      meta: { lastTouchedVersion: "2026.7.1-2" },
      agents: { defaults: { heartbeat: { every: "30m" } }, entries: { main: {} } },
      gateway: { mode: "local" },
    });
    expect(plan?.snapshot.valid).toBe(true);
    expect(plan?.snapshot.issues).toEqual([]);
    expect(snapshot.sourceConfig).toHaveProperty("meta.lastTouchedAt");
  });

  it("accepts the canonical writer metadata stamped onto the repaired stable config", () => {
    const before = invalidSnapshot({
      config: {
        meta: {
          lastTouchedAt: "2026-08-01T00:00:00.000Z",
          lastTouchedVersion: "2026.7.1-2",
        },
        agents: {
          defaults: { heartbeat: { skipWhenBusy: true }, workspace: "/tmp/workspace" },
          entries: { main: {} },
        },
        gateway: { mode: "local" },
      } as OpenClawConfig,
      issuePaths: ["meta", "agents.defaults.heartbeat"],
    });
    const repaired = {
      meta: {
        lastTouchedVersion: VERSION,
        migrations: { modelPolicyAllowlist: true },
      },
      agents: { defaults: { workspace: "/tmp/workspace" }, entries: { main: {} } },
      gateway: { mode: "local" },
    } as OpenClawConfig;
    const after: ConfigFileSnapshot = {
      ...before,
      raw: JSON.stringify(repaired),
      parsed: repaired,
      sourceConfig: repaired,
      resolved: repaired,
      runtimeConfig: repaired,
      config: repaired,
      valid: true,
      issues: [],
      legacyIssues: [],
    };

    expect(isStartupConfigRepairResult(before, after)).toBe(true);
    expect(isStartupConfigRepairResult(before, { ...after, path: "/tmp/other.json" })).toBe(false);
    expect(
      isStartupConfigRepairResult(before, {
        ...after,
        sourceConfig: { ...repaired, gateway: { mode: "remote" } },
      }),
    ).toBe(false);
    expect(
      isStartupConfigRepairResult(before, {
        ...after,
        sourceConfig: { ...repaired, session: { reset: { mode: "idle" } } },
      }),
    ).toBe(false);
  });

  it("plans a config whose only migration is plugin-owned after state admission", () => {
    // The full planner owns plugin contracts; pre-bootstrap uses core-only selection.
    const snapshot = invalidSnapshot({
      config: {
        plugins: { entries: { "active-memory": { config: { qmd: { enabled: true } } } } },
      } as OpenClawConfig,
      issuePaths: ["plugins.entries.active-memory.config.qmd"],
    });

    const resolved = planAutomaticConfigRepair(snapshot)?.snapshot;

    expect(resolved?.valid).toBe(true);
    expect(resolved?.sourceConfig.plugins?.entries?.["active-memory"]?.config).toEqual({});
  });

  it("previews repairable snapshots without touching the shared state database", async () => {
    // Backup discovery and gateway pre-bootstrap resolve before state-database admission;
    // a broken store (here: a directory at the canonical path) must not break the preview.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-startup-repair-preview-"));
    try {
      await fs.mkdir(path.join(root, "state", "openclaw.sqlite"), { recursive: true });
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const snapshot = invalidSnapshot({
          config: {
            session: { idleMinutes: 45 },
            meta: { lastTouchedAt: "2026-02-15T00:00:00.000Z" },
            agents: { list: [{ id: "work", name: "Operator" }] },
            plugins: {
              installs: { example: { source: "path", installPath: "/synthetic/plugin" } },
            },
          } as OpenClawConfig,
          issuePaths: ["session.idleMinutes"],
        });
        const resolved = resolveStartupConfigSnapshot(snapshot);
        expect(resolved?.valid).toBe(true);
        expect(resolved?.sourceConfig.session).toEqual({
          reset: { mode: "idle", idleMinutes: 45 },
        });
        expect(resolved?.sourceConfig).not.toHaveProperty("meta.lastTouchedAt");
        expect(resolved?.sourceConfig).not.toHaveProperty("plugins.installs");
        expect(resolved?.sourceConfig.agents?.entries?.work).toEqual({ name: "Operator" });
        expect(snapshot.sourceConfig).toHaveProperty("plugins.installs.example");
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("carries surviving reference facts through the repair rewrite", () => {
    const config = {
      session: { idleMinutes: 45 },
      models: { providers: { minimax: { apiKey: "substituted-not-a-real-key" } } },
    } as OpenClawConfig;
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["models.providers.minimax.apiKey", "SHORTHAND_KEY"]]),
      ),
    );
    const snapshot = invalidSnapshot({ config, issuePaths: ["session.idleMinutes"] });

    const resolved = resolveStartupConfigSnapshot(snapshot);

    expect(resolved?.sourceConfig.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(collectEnvSecretRefIds(resolved?.sourceConfig)).toEqual(new Set(["SHORTHAND_KEY"]));
    expect(
      getResolvedConfigEnvSecretRef(resolved?.sourceConfig, "models.providers.minimax.apiKey")?.id,
    ).toBe("SHORTHAND_KEY");
  });

  it("retires a reference fact whose path the repair moved", () => {
    // The repair relocates session.idleMinutes, so a fact recorded at the authored path would
    // otherwise keep answering lookups for a value that no longer lives there.
    const config = { session: { idleMinutes: 45 } } as OpenClawConfig;
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        [],
        new Map(),
        "default",
        new Map([["session.idleMinutes", "MOVED_KEY"]]),
      ),
    );
    const snapshot = invalidSnapshot({ config, issuePaths: ["session.idleMinutes"] });

    const resolved = resolveStartupConfigSnapshot(snapshot);

    expect(resolved?.sourceConfig.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
    expect(getResolvedConfigEnvSecretRef(resolved?.sourceConfig, "session.idleMinutes")).toBeNull();
    // The variable is still referenced by the operator's config, so pre-bootstrap cleanup reads
    // the pre-repair snapshot as well and keeps it out of the delete set.
    expect(collectEnvSecretRefIds(snapshot.sourceConfig)).toEqual(new Set(["MOVED_KEY"]));
  });

  it("keeps a real read's ${VAR} reference through a real legacy repair", async () => {
    // The other repair tests stub the facts onto a hand-built snapshot. This one records them the
    // only way production does: a real config file, read by the real reader, substituted for real.
    await withOpenClawTestState({ prefix: "openclaw-repair-real-reader-" }, async (state) => {
      await state.writeConfig({
        session: { idleMinutes: 45 },
        models: {
          providers: {
            minimax: {
              baseUrl: "https://example.invalid/anthropic",
              api: "anthropic-messages",
              apiKey: "${LEGACY_REPAIR_KEY}",
              models: [],
            },
          },
        },
      });

      const snapshot = await readConfigFileSnapshotFromContext(
        createConfigIoContext({
          configPath: state.configPath,
          env: { ...state.env, LEGACY_REPAIR_KEY: "read-substituted-not-a-real-key" },
          homedir: () => state.home,
          observe: false,
        }),
      );
      // Preconditions: substitution really happened, and the legacy key really makes it repairable.
      expect(snapshot.sourceConfig.models?.providers?.minimax?.apiKey).toBe(
        "read-substituted-not-a-real-key",
      );
      expect(collectEnvSecretRefIds(snapshot.sourceConfig)).toEqual(new Set(["LEGACY_REPAIR_KEY"]));
      expect(snapshot.valid).toBe(false);

      const resolved = resolveStartupConfigSnapshot(snapshot);

      expect(resolved?.sourceConfig.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
      // Without the fact transfer the repaired clone reports the substituted literal as an
      // ordinary value, so pre-bootstrap deletes the managed key the config still depends on.
      expect(collectEnvSecretRefIds(resolved?.sourceConfig)).toEqual(
        new Set(["LEGACY_REPAIR_KEY"]),
      );
    });
  });

  it.each([
    { name: "a non-legacy type error", config: { gateway: { port: "not-a-number" } } },
    {
      name: "ambiguous legacy default owners",
      config: {
        session: { idleMinutes: 45 },
        agents: { entries: { main: { default: true }, ops: { default: true } } },
      },
    },
    {
      name: "a migration with a remaining type error",
      config: { session: { idleMinutes: 45 }, gateway: { port: "not-a-number" } },
    },
    {
      name: "an included config source",
      config: { session: { idleMinutes: 45 } },
      includedPaths: ["/tmp/included.json"],
    },
    {
      name: "an include directive without recorded include paths",
      config: { $include: "included.json", session: { idleMinutes: 45 } },
    },
    {
      name: "an unresolved plugin validation failure",
      config: {
        session: { idleMinutes: 45 },
        plugins: { load: { paths: ["/nonexistent-startup-plugin"] } },
      },
    },
    {
      name: "malformed retired plugin records",
      config: { plugins: { installs: { broken: { source: "invalid" } } } },
    },
    {
      name: "another invalid key at a retired key's schema parent",
      config: { meta: { lastTouchedAt: "2026-08-01T00:00:00.000Z", unrelatedRetiredKey: true } },
    },
  ])("refuses $name", ({ config, includedPaths }) => {
    const snapshot = invalidSnapshot({
      config: config as OpenClawConfig,
      issuePaths: [],
      includedPaths,
    });

    expect(planAutomaticConfigRepair(snapshot)).toBeNull();
    if (config.plugins && "installs" in config.plugins) {
      expect(resolveStartupConfigSnapshot(snapshot)).toBeUndefined();
    }
  });
});
