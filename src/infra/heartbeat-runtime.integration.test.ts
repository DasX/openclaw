import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { recordDefaultProactiveJobInDatabase } from "../cron/proactive-job-receipt.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import type { CronServiceDeps } from "../cron/service/state.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { createGatewayInstanceRuntime } from "../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import {
  withPluginRuntimeGatewayRequestScope,
  bindGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createRuntimeSystem } from "../plugins/runtime/runtime-system.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

afterEach(() => clearRuntimeConfigSnapshot());

function bindGatewayInstance(context: GatewayRequestContext) {
  const instance = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => {
      throw new Error("unexpected Gateway method dispatch");
    },
    isDispatchAvailable: () => true,
  });
  context.resolveGatewayContext = () => (instance.isAvailable() ? context : undefined);
  return instance;
}

// Real compatibility adapter, ALS, store, reservation, and cron execution path;
// the agent dependency is the only simulated execution boundary.
describe("stable heartbeat runtime delivery contract", () => {
  it("uses the active plugin's bound Gateway from a native callback outside request ALS", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "heartbeat-sdk-callback-" },
      async (state) => {
        setRuntimeConfigSnapshot({});
        const enqueueSessionEvent = vi.fn();
        const cron = new CronService({
          storePath: state.statePath("cron", "jobs.json"),
          cronEnabled: false,
          log: createNoopLogger(),
          enqueueSessionEvent,
          enqueueSystemEvent: vi.fn(),
          runIsolatedAgentJob: async () => ({ status: "ok" }),
        });
        const context = { cron, getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext;
        const instance = bindGatewayInstance(context);
        const runtime = createPluginRuntime();
        bindGatewayContextResolver(runtime.subagent, () => context);
        const builder = createPluginRegistry({
          runtime,
          logger: createNoopLogger(),
          activateGlobalSideEffects: false,
        });
        const record = createPluginRecord({ id: "callback-fixture", origin: "bundled" });
        const api = builder.createApi(record, { config: {} });
        builder.registry.plugins.push(record);
        markPluginRegistryActive(builder.registry);
        try {
          expect(() =>
            api.runtime.system.requestHeartbeatNow({
              agentId: "main",
              sessionKey: "agent:main:main",
            }),
          ).not.toThrow();
          expect(enqueueSessionEvent).toHaveBeenCalledOnce();
        } finally {
          instance.close();
          markPluginRegistryRetired(builder.registry);
          cron.stop();
        }
      },
    );
  });
  it.each(["none", "last", "slack"])(
    "runs the canonical job with per-call target %s",
    async (target) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "heartbeat-sdk-contract-" },
        async (state) => {
          const storePath = path.join(state.stateDir, "cron", "jobs.json");
          const cfg: OpenClawConfig = {
            agents: { list: [{ id: "main", default: true }] },
          };
          const job = makeCronJob({
            id: "converted",
            agentId: "main",
            sessionTarget: "isolated",
            schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
            delivery: {
              mode: "announce",
              target: "owner",
              directPolicy: "block",
              accountId: "primary",
            },
          });
          await saveCronStore(storePath, { version: 1, jobs: [job] });
          runOpenClawStateWriteTransaction(({ db }) => {
            recordDefaultProactiveJobInDatabase(db, storePath, "main", job.id, Date.now());
          });
          const original = (await loadCronStore(storePath)).jobs[0]!;
          const revision = resolveCronJobConfigRevision(original);
          const execute = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(
            async ({ job: effective }) => {
              expect((await loadCronStore(storePath)).jobs[0]?.delivery).toEqual(original.delivery);
              expect(effective.delivery).toMatchObject({
                mode: target === "none" ? "none" : "announce",
                target: "owner",
                directPolicy: "block",
                accountId: "primary",
              });
              expect(effective.delivery?.channel).toBe(target === "none" ? undefined : target);
              expect(resolveCronJobConfigRevision(effective)).not.toBe(revision);
              return { status: "ok", executionStarted: true };
            },
          );
          const cron = new CronService({
            storePath,
            cronEnabled: false,
            defaultAgentId: "main",
            log: createNoopLogger(),
            enqueueSystemEvent: () => {
              throw new Error("unexpected passive event");
            },
            enqueueSessionEvent: () => {
              throw new Error("unexpected alternate execution");
            },
            runIsolatedAgentJob: execute,
          });
          const context = { cron, getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext;
          try {
            const outcome = await withPluginRuntimeGatewayRequestScope(
              { context, isWebchatConnect: () => false },
              () =>
                createRuntimeSystem().runHeartbeatOnce({ agentId: "main", heartbeat: { target } }),
            );
            expect(outcome).toMatchObject({ status: "ran" });
            expect(execute).toHaveBeenCalledOnce();
            const retained = (await loadCronStore(storePath)).jobs[0]!;
            expect(retained.delivery).toEqual(job.delivery);
            expect({
              ...retained,
              state: original.state,
              updatedAtMs: original.updatedAtMs,
            }).toEqual(original);
            expect(resolveCronJobConfigRevision(retained)).toBe(revision);
          } finally {
            cron.stop();
          }
        },
      );
    },
  );
});

async function withRuntimeOwner(
  run: (fixture: {
    api: ReturnType<ReturnType<typeof createPluginRegistry>["createApi"]>;
    cron: CronService;
    enqueue: ReturnType<typeof vi.fn>;
    activate: () => void;
    retire: () => void;
    closeGateway: () => void;
    replace: () => ReturnType<ReturnType<typeof createPluginRegistry>["createApi"]>;
  }) => Promise<void>,
  activate = true,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "heartbeat-owner-" },
    async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      setRuntimeConfigSnapshot(cfg);
      const job = makeCronJob({ id: "owner-check", agentId: "main", sessionTarget: "isolated" });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      runOpenClawStateWriteTransaction(({ db }) =>
        recordDefaultProactiveJobInDatabase(db, storePath, "main", job.id, Date.now()),
      );
      const enqueue = vi.fn();
      const cron = new CronService({
        storePath: state.statePath("cron", "jobs.json"),
        cronEnabled: false,
        log: createNoopLogger(),
        enqueueSessionEvent: enqueue,
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: async () => {
          throw new Error("unexpected job execution");
        },
      });
      const context = { cron, getRuntimeConfig: () => cfg } as unknown as GatewayRequestContext;
      const instance = bindGatewayInstance(context);
      const runtime = createPluginRuntime();
      // Production keeps this startup pointer after close; the instance owns availability.
      bindGatewayContextResolver(runtime.subagent, () => context);
      const builder = createPluginRegistry({
        runtime,
        logger: createNoopLogger(),
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({ id: "callback-owner", origin: "bundled" });
      const api = builder.createApi(record, { config: {} });
      builder.registry.plugins.push(record);
      if (activate) {
        markPluginRegistryActive(builder.registry);
      }
      try {
        await run({
          api,
          cron,
          enqueue,
          activate: () => markPluginRegistryActive(builder.registry),
          retire: () => markPluginRegistryRetired(builder.registry),
          closeGateway: () => instance.close(),
          replace: () => {
            const replacement = createPluginRecord({ id: record.id, origin: "bundled" });
            const nextApi = builder.createApi(replacement, { config: {} });
            builder.registry.plugins.splice(0, 1, replacement);
            return nextApi;
          },
        });
      } finally {
        markPluginRegistryRetired(builder.registry);
        instance.close();
        cron.stop();
      }
    },
  );
}

const destination = { agentId: "main", sessionKey: "agent:main:main" };
describe("plugin system registration ownership", () => {
  it("admits a callback captured before the first activation", async () => {
    await withRuntimeOwner(async ({ api, activate, enqueue }) => {
      const wake = api.runtime.system.requestHeartbeatNow;
      activate();
      wake(destination);
      expect(enqueue).toHaveBeenCalledOnce();
    }, false);
  });

  it("does not mint first-use authority after the original activation was replaced", async () => {
    await withRuntimeOwner(async ({ api, activate, retire, enqueue }) => {
      const wake = api.runtime.system.requestHeartbeatNow;
      activate();
      retire();
      activate();
      expect(() => wake(destination)).toThrow("original active registration");
      expect(enqueue).not.toHaveBeenCalled();
    }, false);
  });

  it.each(["retire", "replace", "reactivate", "gateway-close"])(
    "fences retained and copied methods after %s",
    async (change) => {
      await withRuntimeOwner(async (fixture) => {
        const retained = { ...fixture.api.runtime.system };
        if (change === "retire") {
          fixture.retire();
        }
        if (change === "replace") {
          fixture.replace();
        }
        if (change === "reactivate") {
          fixture.retire();
          fixture.activate();
        }
        if (change === "gateway-close") {
          fixture.closeGateway();
        }
        expect(() => retained.requestHeartbeatNow(destination)).toThrow(
          "original active registration",
        );
        expect(() => retained.runHeartbeatOnce(destination)).toThrow(
          "original active registration",
        );
        expect(fixture.enqueue).not.toHaveBeenCalled();
      });
    },
  );

  it("cannot redeem a retired registration's original opaque target through its replacement", async () => {
    await withRuntimeOwner(async ({ api, replace }) => {
      const expectedTarget = api.runtime.system.captureSessionEventTarget(
        destination.agentId,
        destination.sessionKey,
      );
      const replacement = replace();
      expect(() =>
        replacement.runtime.system.enqueueSessionEvent("old work", {
          ...destination,
          expectedTarget,
        }),
      ).toThrow("original active registration");
    });
  });

  it("rechecks its exact Gateway after awaited canonical job lookup", async () => {
    await withRuntimeOwner(async ({ api, cron, closeGateway }) => {
      const list = cron.list.bind(cron);
      vi.spyOn(cron, "list").mockImplementationOnce(async (options) => {
        const jobs = await list(options);
        closeGateway();
        return jobs;
      });
      await expect(api.runtime.system.runHeartbeatOnce({ agentId: "main" })).rejects.toThrow(
        "original active registration",
      );
    });
  });

  it("routes event intent immediately and retains its captured internal-only policy", async () => {
    await withRuntimeOwner(async ({ api, enqueue }) => {
      api.runtime.system.requestHeartbeat({
        ...destination,
        source: "notifications-event",
        intent: "event",
        heartbeat: { target: "none" },
      });
      expect(enqueue).toHaveBeenCalledExactlyOnceWith(
        "Review pending session events.",
        expect.objectContaining({
          ...destination,
          expectedTarget: expect.objectContaining({
            ...destination,
            deliver: false,
            assertCurrent: expect.any(Function),
          }),
        }),
      );
    });
  });
});
