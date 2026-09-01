/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";
import * as gatewayStore from "./gateway-store.ts";
import { loadSettings, persistSessionToken } from "./settings.ts";

const NATIVE_AUTH_KEY = "__OPENCLAW_NATIVE_CONTROL_AUTH__";
const originalUrl = window.location.href;
let runtime: ApplicationRuntime | undefined;

function setNativeAuth(auth: { gatewayUrl: string; token?: string; password?: string }) {
  window[NATIVE_AUTH_KEY] = auth;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  runtime?.stop();
  runtime = undefined;
  delete window[NATIVE_AUTH_KEY];
  window.history.replaceState({}, "", originalUrl);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pending Gateway credentials", () => {
  it("re-scopes credentials before confirming a changed Gateway URL", () => {
    const currentGatewayUrl = "wss://gateway.example/openclaw";
    const nextGatewayUrl = "wss://other-gateway.example/openclaw";
    persistSessionToken(nextGatewayUrl, "next-token");
    setNativeAuth({
      gatewayUrl: currentGatewayUrl,
      token: "old-token",
      password: "old-password",
    });
    window.history.replaceState({}, "", `/#gatewayUrl=${encodeURIComponent(nextGatewayUrl)}`);
    runtime = bootstrapApplication({ sessionPathBuilderReady: new Promise<void>(() => {}) });

    runtime.confirmPendingGatewayConnection();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(nextGatewayUrl);
    expect(runtime.context.gateway.connection.token).toBe("next-token");
    expect(runtime.context.gateway.connection.password).toBe("");
    persistSessionToken(nextGatewayUrl, "");
  });

  it("holds a bootstrap token until its changed Gateway URL is confirmed", () => {
    const currentGatewayUrl = "wss://gateway.example/openclaw";
    const nextGatewayUrl = "wss://other-gateway.example/openclaw";
    setNativeAuth({ gatewayUrl: currentGatewayUrl });
    window.history.replaceState(
      {},
      "",
      `/#gatewayUrl=${encodeURIComponent(nextGatewayUrl)}&bootstrapToken=next-bootstrap`,
    );
    runtime = bootstrapApplication({ sessionPathBuilderReady: new Promise<void>(() => {}) });

    expect(runtime.context.gateway.connection.bootstrapToken).toBe("");

    runtime.confirmPendingGatewayConnection();

    expect(runtime.context.gateway.connection.gatewayUrl).toBe(nextGatewayUrl);
    expect(runtime.context.gateway.connection.bootstrapToken).toBe("next-bootstrap");
  });

  it("uses paired-device credentials while other connection bootstrap work is pending", async () => {
    const gatewayUrl = "ws://localhost";
    setNativeAuth({ gatewayUrl });
    window.history.replaceState({}, "", "/settings/appearance");
    const store = createGatewayStoreTestStore({
      settings: { ...loadSettings(), gatewayUrl, token: "" },
    });
    vi.spyOn(gatewayStore, "createApplicationGateway").mockReturnValue(store.gateway);
    const pending = createDeferred();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (new Headers(init?.headers).get("Authorization") !== "Bearer fixture-device-token") {
        return new Response(null, { status: 401 });
      }
      return new Response(
        JSON.stringify({
          serverVersion: "paired",
          pluginAssetsRequireAuth: true,
          pluginFrameGrants: [
            {
              pluginId: "fixture",
              path: "/__openclaw__/plugins/control-ui/fixture/",
              match: "prefix",
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    runtime = bootstrapApplication({ sessionPathBuilderReady: new Promise<void>(() => {}) });
    runtime.context.gateway.start();
    const client = store.current();
    client.request.mockImplementation(async (method) => {
      if (method === "update.status" || method === "exec.approval.list") {
        await pending.promise;
      }
      return {};
    });

    try {
      client.opts.onHello?.({
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "fixture-device-token" },
      });
      await vi.waitFor(() => {
        const methods = client.request.mock.calls.map(([method]) => method);
        expect(methods).toContain("update.status");
        expect(methods).toContain("exec.approval.list");
      });
      expect(fetchMock).not.toHaveBeenCalled();

      // Native plugin activation requests its grant before unrelated queued
      // startup RPCs finish; the connected Gateway already owns its credential.
      await expect(runtime.context.config.refresh()).resolves.toMatchObject({
        serverVersion: "paired",
        pluginFrameGrants: [{ pluginId: "fixture" }],
      });
    } finally {
      runtime.stop();
      pending.resolve();
    }
  });
});
