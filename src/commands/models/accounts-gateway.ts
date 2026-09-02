import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.js";
import { resolveGatewayLocalPortOverride } from "../../cli/gateway-port-option.js";
import { resolveGatewayAuthOptions } from "../../cli/gateway-secret-options.js";
import { parseTimeoutMsWithFallback } from "../../cli/parse-timeout.js";
import { readGatewayDispatchConfigWithShellEnvFallback } from "../../config/gateway-dispatch-config.js";
import { resolveGatewayClientBootstrap } from "../../gateway/client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "../../gateway/client-start-readiness.js";
import { GatewayClient } from "../../gateway/client.js";
import {
  gatewayEdgeAuthValueForTarget,
  normalizeEdgeAuthHeadersConfig,
  resolveEdgeAuthHeaders,
} from "../../gateway/edge-auth.js";
import { loadOriginDeviceToken } from "../../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../../infra/device-identity.js";
import { ExitError } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";

export type ModelsAccountsGatewayOptions = {
  url?: string;
  port?: string;
  tokenFile?: string;
  passwordFile?: string;
  timeout?: string;
};

export async function withModelsAccountsGateway<T>(
  options: ModelsAccountsGatewayOptions,
  access: "read" | "write",
  run: (client: GatewayClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const localPortOverride = resolveGatewayLocalPortOverride(options);
  const timeoutMs = resolveTimerTimeoutMs(
    parseTimeoutMsWithFallback(options.timeout, 30_000, { invalidType: "error" }),
    30_000,
  );
  const config = await readGatewayDispatchConfigWithShellEnvFallback();
  const { gatewayToken: token, gatewayPassword: password } = resolveGatewayAuthOptions(options);
  const identity = loadDeviceIdentityIfPresent();
  const bootstrap = await resolveGatewayClientBootstrap({
    config,
    gatewayUrl: options.url,
    localPortOverride,
    explicitAuth: { token, password },
    allowStoredOriginAuth: (gatewayScope) =>
      Boolean(
        identity &&
        loadOriginDeviceToken({ gatewayScope, deviceId: identity.deviceId, role: "operator" })
          ?.token,
      ),
    overrideAuthErrorHint:
      "For personal accounts, use the configured Gateway through its identity-authenticated endpoint. URL overrides need explicit Gateway credentials or a cached device token; neither identifies a person.",
  });
  const edgeAuthHeaders = await resolveEdgeAuthHeaders({
    config,
    value: normalizeEdgeAuthHeadersConfig(
      gatewayEdgeAuthValueForTarget({ config, targetUrl: bootstrap.url }),
    ),
    targetUrl: bootstrap.url,
    env: process.env,
  });
  const lifetime = new AbortController();
  const ready = createDeferredCore();
  const fail = (error: Error) => {
    lifetime.abort(error);
    ready.reject(error);
    client.stop();
  };
  const client = new GatewayClient({
    url: bootstrap.url,
    deviceAuthScope: bootstrap.deviceAuthScope,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    edgeAuthHeaders,
    tlsFingerprint: bootstrap.tlsFingerprint,
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    requestTimeoutMs: timeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "openclaw models accounts",
    mode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    scopes: access === "write" ? ["operator.read", "operator.write"] : ["operator.read"],
    minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    notifyOnStartupRetry: true,
    onHelloOk: () => ready.resolve(),
    onConnectError: fail,
    onClose: () => {
      // A personal connect belongs to this socket; never move it to a reconnect.
      fail(new Error("Gateway connection closed. Re-run the personal-account command."));
    },
  });
  const cancel = () => {
    const error = new ExitError(130, "Personal account operation cancelled.");
    lifetime.abort(error);
    ready.reject(error);
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timer = setTimeout(() => fail(new Error("Gateway connection timed out.")), timeoutMs);
  try {
    await Promise.all([
      ready.promise,
      startGatewayClientWhenEventLoopReady(client, {
        timeoutMs,
        signal: lifetime.signal,
        clientOptions: { preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs },
      }).then((result) => {
        if (!result.ready) {
          throw lifetime.signal.reason ?? new Error("Gateway connection timed out.");
        }
        return result;
      }),
    ]);
    clearTimeout(timer);
    lifetime.signal.throwIfAborted();
    return await run(client, lifetime.signal);
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    lifetime.abort();
    try {
      await client.stopAndWait({ timeoutMs: 1_000 });
    } catch {
      client.stop();
    }
  }
}
