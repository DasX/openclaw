import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { writePersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createPluginRegistry } from "../plugins/registry.js";
import {
  clearActivePluginRegistry,
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "../plugins/test-helpers/managed-npm-plugin.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

const mocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  loadPluginLookUpTable: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));
vi.mock("../plugins/plugin-lookup-table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-lookup-table.js")>()),
  loadPluginLookUpTable: mocks.loadPluginLookUpTable,
}));

const cleanups: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPluginMetadataSnapshot.mockReset();
  mocks.loadPluginLookUpTable.mockReset();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  mocks.loadPluginMetadataSnapshot.mockImplementation(() =>
    Object.assign(
      createPluginMetadataSnapshotFixture({ plugins: [{ id: "first" }, { id: "sibling" }] }),
      { discovery: { candidates: [], diagnostics: [] } },
    ),
  );
});

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
    await clearActivePluginRegistry();
  } finally {
    clearRuntimeConfigSnapshot();
    resetGatewayWorkAdmission();
    clearPluginMetadataLifecycleCaches();
    cleanupTrackedTempDirs(tempDirs);
  }
});

async function createRecoveryFixture(
  options: {
    abortOnCandidateStart?: boolean;
    prepareAttached?: () => Promise<void>;
    initialStop?: () => Promise<void>;
    beforePublish?: () => Promise<void>;
    afterPublish?: () => Promise<void>;
    assertInvokerOwned?: () => void;
    candidateStart?: () => void;
    candidateStop?: () => Promise<void>;
    recoveryStart?: () => Promise<void>;
    recoveryStop?: () => Promise<void>;
  } = {},
) {
  const config: OpenClawConfig = {
    plugins: { allow: ["first", "sibling"] },
  };
  setRuntimeConfigSnapshot(config);
  const log = { ...createSubsystemLogger("gateway/plugins"), ...mocks.log };
  const createBuilder = () =>
    createPluginRegistry({
      logger: log,
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
  const previous = createBuilder();
  let firstStarts = 0;
  let aborted = false;
  const firstStart = vi.fn(async () => {
    firstStarts += 1;
    if (firstStarts > 1) {
      await options.recoveryStart?.();
    }
  });
  const firstStop = vi.fn(async () => {
    if (firstStarts > 1) {
      await options.recoveryStop?.();
    } else {
      await options.initialStop?.();
    }
  });
  const firstRecord = createPluginRecord({ id: "first" });
  previous.registry.plugins.push(firstRecord);
  previous.createApi(firstRecord, { config }).registerService({
    id: "first",
    start: firstStart,
    stop: firstStop,
  });
  const siblingStart = vi.fn();
  const siblingStop = vi.fn();
  const siblingRecord = createPluginRecord({ id: "sibling" });
  previous.registry.plugins.push(siblingRecord);
  previous.createApi(siblingRecord, { config }).registerService({
    id: "sibling",
    start: siblingStart,
    stop: siblingStop,
  });
  setActivePluginRegistry(previous.registry);
  const registryOwner = createPluginRegistryOwner(previous.registry);
  const initial = await startPluginServices({ registry: previous.registry, config });
  let currentServices: PluginServicesHandle | null = initial;
  const owner = createGatewayPluginRuntimeGeneration({
    getServices: () => currentServices,
    setServices: (handle) => {
      currentServices = handle;
    },
  });
  const candidateStop = vi.fn(async () => await options.candidateStop?.());
  const candidates: ReturnType<typeof createBuilder>[] = [];
  const preparePlugins = () => {
    const candidate = createBuilder();
    candidates.push(candidate);
    const record = createPluginRecord({ id: "first" });
    candidate.registry.plugins.push(record, siblingRecord);
    candidate.createApi(record, { config }).registerService({
      id: "first",
      start: () => {
        aborted = options.abortOnCandidateStart !== false;
        options.candidateStart?.();
      },
      stop: async () => await candidateStop(),
    });
    candidate.registry.services.push(
      ...previous.registry.services.filter((entry) => entry.pluginId === "sibling"),
    );
    return {
      pluginRegistry: candidate.registry,
      resolvedConfig: config,
      gatewayMethods: [],
      retireGatewayRuntimeBindings: vi.fn(),
    };
  };
  const runtime = {
    pluginRuntime: registryOwner,
    kernel: { pluginRuntimeGeneration: owner },
    runtimeState: { cronState: {} },
    ambientEnvTriggers: "suppress",
    coreGatewayMethodNames: [],
    baseMethods: [],
    channelManager: {
      getPluginCommandCatalogAccounts: () => new Map(),
      setAmbientAutostartSuppressedChannelIds: vi.fn(),
    },
    clients: new Set(),
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
  cleanups.push(async () => {
    await currentServices?.stop().catch(() => {});
    await initial.stop().catch(() => {});
    await registryOwner.close();
    for (const candidate of candidates) {
      await disposePluginRegistryInstances(candidate.registry, previous.registry);
    }
  });
  const reload = () => {
    aborted = false;
    return reloadGatewayPlugins(
      {
        runtime,
        port: 0,
        log,
        loadGatewayPluginBootstrapModule: async () => ({
          prepareGatewayPluginLoad: preparePlugins,
        }),
        prepareAttachedPluginRuntime: async (candidate) => {
          await options.prepareAttached?.();
          return {
            publish: () => {
              activatePluginRegistry(
                candidate.pluginRegistry,
                null,
                "gateway-bindable",
                undefined,
                registryOwner.registry,
              );
              registryOwner.publish(candidate.pluginRegistry);
            },
            afterCommit: vi.fn(),
          };
        },
        refreshAttachedGatewayDiscovery: async () => {},
      },
      {
        nextConfig: config,
        sourceConfig: config,
        changedPaths: [],
        pluginLifecycle: {
          reason: "reload",
          operationId: "service-recovery",
          pluginIds: ["first"],
        },
        commitRuntime: async (publication) => {
          await options.beforePublish?.();
          publication?.publish();
          publication?.afterCommit?.();
          await options.afterPublish?.();
        },
        env: {},
        isAborted: () => aborted,
        assertInvokerOwned: options.assertInvokerOwned,
      },
    );
  };
  return {
    owner,
    registryOwner,
    previousRegistry: previous.registry,
    reload,
    firstStart,
    firstStop,
    siblingStart,
    siblingStop,
    candidateStop,
  };
}

describe("Gateway plugin service recovery ownership", () => {
  it.each(["prepare", "drain", "publish", "committed"] as const)(
    "preserves the committed owner when its invoker closes during %s",
    async (boundary) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("plugin invoker closed");
      let invokerOpen = true;
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const candidateStart = vi.fn();
      const fixture = await createRecoveryFixture({
        abortOnCandidateStart: false,
        candidateStart,
        ...(boundary === "prepare" ? { prepareAttached: pause } : {}),
        ...(boundary === "drain" ? { initialStop: pause } : {}),
        ...(boundary === "publish" ? { beforePublish: pause } : {}),
        ...(boundary === "committed" ? { afterPublish: pause } : {}),
        assertInvokerOwned: () => {
          if (!invokerOpen) {
            throw failure;
          }
        },
      });
      const pending = fixture.reload().catch((error: unknown) => error);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("plugin reload completed before its pause");
          }),
        ]);
        invokerOpen = false;
        release.resolve();
        const result = await pending;
        if (boundary === "committed") {
          expect(result).toMatchObject({
            runtime: { operationId: "service-recovery", pluginIds: ["first"] },
          });
          expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
          const previousRecord = fixture.previousRegistry.plugins.find(
            (record) => record.id === "first",
          );
          assert.ok(previousRecord);
          expect(getPluginInstance(previousRecord)?.lifecycle.signal.aborted).toBe(true);
          expect(fixture.firstStart).toHaveBeenCalledOnce();
          expect(fixture.candidateStop).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({
            details: { phase: boundary === "publish" ? "activate" : boundary, committed: false },
            cause: failure,
          });
          expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
          expect(fixture.firstStart).toHaveBeenCalledTimes(boundary === "prepare" ? 1 : 2);
          expect(fixture.candidateStop).toHaveBeenCalledTimes(boundary === "publish" ? 1 : 0);
        }
        expect(candidateStart).toHaveBeenCalledTimes(
          boundary === "publish" || boundary === "committed" ? 1 : 0,
        );
        expect(fixture.siblingStart).toHaveBeenCalledOnce();
        expect(fixture.siblingStop).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it("keeps retained and failed-recovery services owned after recovery startup rejects", async () => {
    const startFailure = new Error("previous service failed to restart");
    const stopFailure = new Error("previous service cleanup failed");
    const fixture = await createRecoveryFixture({
      recoveryStart: async () => {
        throw startFailure;
      },
      recoveryStop: async () => {
        throw stopFailure;
      },
    });
    const failure = await fixture.reload().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      details: { phase: "activate", committed: false },
      cause: {
        errors: [
          expect.any(GatewayConfigReloadSupersededError),
          expect.objectContaining({ errors: expect.arrayContaining([startFailure]) }),
        ],
      },
    });
    expect(fixture.firstStart).toHaveBeenCalledTimes(2);
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    const shutdown = await fixture.owner
      .currentServices()!
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);
    expect(shutdown).toMatchObject({
      errors: [expect.objectContaining({ cause: stopFailure })],
    });
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    expect(fixture.firstStop).toHaveBeenCalledTimes(2);
  });

  it("retains failed candidate cleanup without starting an overlapping old service on later reload", async () => {
    const stopFailure = new Error("candidate service cleanup failed");
    const fixture = await createRecoveryFixture({
      candidateStop: async () => {
        throw stopFailure;
      },
    });
    for (const phase of ["activate", "drain"]) {
      const failure = await fixture.reload().catch((error: unknown) => error);
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(failure).toMatchObject({
        details: { phase, committed: false },
        cause: {
          message: "Plugin replacement failed and its previous instance could not be restored.",
        },
      });
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).not.toHaveBeenCalled();
    }
    const shutdown = await fixture.owner
      .currentServices()!
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);
    expect(shutdown).toMatchObject({
      errors: [expect.objectContaining({ cause: stopFailure })],
    });
    expect(fixture.siblingStop).toHaveBeenCalledOnce();
    expect(fixture.candidateStop).toHaveBeenCalledOnce();
  });

  it("publishes retained services before awaited cleanup when admission closes and recovery is skipped", async () => {
    const cleanupEntered = createDeferredCore();
    const cleanupReleased = createDeferredCore();
    const fixture = await createRecoveryFixture({
      candidateStart: markGatewayRestartDraining,
      candidateStop: async () => {
        cleanupEntered.resolve();
        await cleanupReleased.promise;
      },
    });
    const reloading = fixture.reload().catch((error: unknown) => error);
    try {
      await Promise.race([
        cleanupEntered.promise,
        reloading.then((error) => {
          throw error;
        }),
      ]);
      const shuttingDown = fixture.owner.currentServices()!.stop();
      cleanupReleased.resolve();
      const failure = await reloading;
      await shuttingDown;
      expect(failure).toMatchObject({ details: { phase: "activate", committed: false } });
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStart).toHaveBeenCalledOnce();
      expect(fixture.siblingStop).toHaveBeenCalledOnce();
      expect(fixture.candidateStop).toHaveBeenCalledOnce();
    } finally {
      cleanupReleased.resolve();
      await reloading;
    }
  });
});

it("loads installed package roots from the durable ledger and refreshes their helpers without restarting siblings", async () => {
  const metadata = await vi.importActual<typeof import("../plugins/plugin-metadata-snapshot.js")>(
    "../plugins/plugin-metadata-snapshot.js",
  );
  const lookup = await vi.importActual<typeof import("../plugins/plugin-lookup-table.js")>(
    "../plugins/plugin-lookup-table.js",
  );
  mocks.loadPluginMetadataSnapshot.mockImplementation(metadata.loadPluginMetadataSnapshot);
  mocks.loadPluginLookUpTable.mockImplementation(lookup.loadPluginLookUpTable);
  const bootstrap = await import("./server-plugin-bootstrap.js");
  const root = makeTrackedTempDir("openclaw-gateway-plugin-ledger-reload", tempDirs);
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
  };
  const writePackage = (id: string) => {
    const packageDir = writeManagedNpmPlugin({
      stateDir,
      packageName: id,
      pluginId: id,
      version: "1.0.0",
    });
    fs.writeFileSync(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id, activation: { onStartup: true }, configSchema: { type: "object" } }),
    );
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "A";');
    fs.writeFileSync(
      path.join(packageDir, "dist", "index.js"),
      `const helper = require("./helper.cjs");
const instance = require("node:crypto").randomUUID();
let starts = 0, stops = 0;
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  api.registerService({ id: ${JSON.stringify(id)}, start() { starts++; }, stop() { stops++; } });
  api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => {
    respond(true, { helper, instance, starts, stops });
  });
} };`,
    );
    return packageDir;
  };
  await withEnvAsync(env, async () => {
    const siblingDir = writePackage("sibling");
    const initialConfig: OpenClawConfig = {
      plugins: {
        allow: ["sibling"],
        entries: { sibling: { enabled: true } },
        load: { paths: [siblingDir] },
        slots: { memory: "none" },
      },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const log = { ...createSubsystemLogger("gateway/plugins"), ...mocks.log };
    const initial = bootstrap.prepareGatewayPluginLoad({
      cfg: initialConfig,
      workspaceDir,
      env,
      log,
      baseMethods: [],
      ambientEnvTriggers: "suppress",
    });
    let currentServices: PluginServicesHandle | null = await startPluginServices({
      registry: initial.pluginRegistry,
      config: initialConfig,
      workspaceDir,
    });
    const owner = createGatewayPluginRuntimeGeneration({
      getServices: () => currentServices,
      setServices: (handle) => {
        currentServices = handle;
      },
    });
    const registryOwner = createPluginRegistryOwner(initial.pluginRegistry, workspaceDir);
    const loaded = [initial];
    cleanups.push(async () => {
      try {
        await currentServices?.stop({ strict: true, deadlineAtMs: Date.now() + 5_000 });
      } finally {
        for (const generation of loaded) {
          generation.retireGatewayRuntimeBindings?.();
        }
        await registryOwner.close();
      }
    });
    const runtime = {
      pluginRuntime: registryOwner,
      pluginWorkspaceDir: workspaceDir,
      kernel: { pluginRuntimeGeneration: owner },
      runtimeState: { cronState: {} },
      ambientEnvTriggers: "suppress",
      coreGatewayMethodNames: [],
      baseMethods: [],
      channelManager: {
        getPluginCommandCatalogAccounts: () => new Map(),
        setAmbientAutostartSuppressedChannelIds: vi.fn(),
      },
      clients: new Set(),
      broadcast: vi.fn(),
    } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
    const probe = async (id: string) => {
      const method = `${id}.probe`;
      const respond = vi.fn();
      const handler = runtime.pluginRuntime.registry.gatewayHandlers[method];
      assert.ok(handler, `${method} must be registered`);
      await handler({
        req: { type: "req", id: "ledger-reload", method },
        params: {},
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: {} as GatewayRequestHandlerOptions["context"],
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          helper: expect.any(String),
          instance: expect.any(String),
          starts: 1,
          stops: 0,
        },
        undefined,
        undefined,
      );
      const response = respond.mock.calls[0];
      assert.ok(response);
      return response[1];
    };
    const sibling = await probe("sibling");
    const siblingRecord = initial.pluginRegistry.plugins.find((record) => record.id === "sibling");
    const siblingHandler = initial.pluginRegistry.gatewayHandlers["sibling.probe"];
    const packageDir = writePackage("installed-probe");
    const config: OpenClawConfig = {
      plugins: {
        ...initialConfig.plugins,
        allow: ["sibling", "installed-probe"],
        entries: { sibling: { enabled: true }, "installed-probe": { enabled: true } },
      },
    };
    // Managed npm roots live outside discovery directories and are owned by the persisted ledger.
    writePersistedInstalledPluginIndexSync(
      loadInstalledPluginIndex({
        config,
        env,
        workspaceDir,
        installRecords: {
          "installed-probe": {
            source: "npm",
            spec: "installed-probe@1.0.0",
            installPath: packageDir,
          },
        },
      }),
      { env },
    );
    const reload = async () =>
      await reloadGatewayPlugins(
        {
          runtime,
          port: 0,
          log,
          loadGatewayPluginBootstrapModule: async () => bootstrap,
          prepareAttachedPluginRuntime: async (candidate) => {
            loaded.push(candidate);
            return {
              publish: () => {
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  workspaceDir,
                  runtime.pluginRuntime.registry,
                );
                registryOwner.publish(candidate.pluginRegistry);
              },
              afterCommit: () => {},
            };
          },
          refreshAttachedGatewayDiscovery: async () => {},
        },
        {
          nextConfig: config,
          sourceConfig: config,
          changedPaths: [],
          pluginLifecycle: {
            reason: "reload",
            operationId: "installed-package-reload",
            pluginIds: ["installed-probe"],
          },
          commitRuntime: async (publication) => {
            publication?.publish();
            setRuntimeConfigSnapshot(config);
            publication?.afterCommit?.();
          },
          env,
        },
      );
    await reload();
    const first = await probe("installed-probe");
    expect(first.helper).toBe("A");
    fs.writeFileSync(path.join(packageDir, "dist", "helper.cjs"), 'module.exports = "B";');
    await reload();
    const second = await probe("installed-probe");
    expect(second.helper).toBe("B");
    expect(second.instance).not.toBe(first.instance);
    expect(runtime.pluginRuntime.registry.plugins.find((record) => record.id === "sibling")).toBe(
      siblingRecord,
    );
    expect(runtime.pluginRuntime.registry.gatewayHandlers["sibling.probe"]).toBe(siblingHandler);
    expect(await probe("sibling")).toEqual(sibling);
  });
});
