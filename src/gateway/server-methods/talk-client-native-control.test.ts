import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { TalkRealtimeConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { flushClientVoiceSessionWrites } from "../../talk/client-voice-session.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createResponse } from "../server-http.test-harness.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../talk-client-gateway-control.js";
import { cleanupTalkConnection } from "../talk-session-registry.js";
import { talkClientHandlers } from "./talk-client.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const upstream = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const sockets: NativeSocket[] = [];
  class NativeSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    readyState = 0;
    sent: string[] = [];

    constructor(readonly url: string) {
      super();
      sockets.push(this);
    }

    open(): void {
      this.readyState = NativeSocket.OPEN;
      this.emit("open");
    }

    send(payload: string): void {
      this.sent.push(payload);
    }

    close(code = 1000, reason = "closed"): void {
      if (this.readyState === NativeSocket.CLOSED) {
        return;
      }
      this.readyState = NativeSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    }

    serverEvent(event: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(event)), false);
    }
  }
  const oauthToken = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "native-test" } }),
    ).toString("base64url"),
    "synthetic-signature",
  ].join(".");
  return {
    NativeSocket,
    sockets,
    fetch: vi.fn<typeof fetch>(),
    authConfigured: vi.fn(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    ),
    resolveAuth: vi.fn(async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
      profileTypes?.includes("oauth") ? oauthToken : undefined,
    ),
  };
});

vi.mock("ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ws")>()),
  default: upstream.NativeSocket,
  WebSocket: upstream.NativeSocket,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  isProviderAuthProfileConfigured: upstream.authConfigured,
  resolveProviderAuthProfileApiKey: upstream.resolveAuth,
}));

const pluginModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "openai",
  artifactBasename: "index.js",
});
const { default: openaiPlugin }: { default: OpenClawPluginDefinition } = await import(
  pluginModuleId
);

type PluginApi = ReturnType<typeof createTestPluginApi>;
type HttpRoute = Parameters<PluginApi["registerHttpRoute"]>[0];
type PluginLifecycle = Parameters<PluginApi["registerRuntimeLifecycle"]>[0];
const AGENT_ID = "voice";
const SESSION_KEY = "agent:voice:main";
const SESSION_ID = "native-control-transcript";
const CONNECTION_ID = "native-control-client";
const AUDIO_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const DATA_CHANNEL_SDP = `${AUDIO_SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Expected nonempty ${key}`);
  }
  return value;
}

function requireSuccessfulReply(respond: ReturnType<typeof vi.fn<RespondFn>>) {
  const reply = respond.mock.calls.at(-1);
  if (!reply) {
    throw new Error("Talk handler did not respond");
  }
  const [ok, payload, error] = reply;
  // Report the public rejection, never the credential-bearing session payload.
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  if (!isRecord(payload)) {
    throw new Error("Expected a Talk result object");
  }
  return payload;
}

async function withNativePlugin(
  run: (fixture: {
    create: (negotiated: boolean) => Promise<Record<string, unknown>>;
    invoke: (
      method: keyof typeof talkClientHandlers,
      params: Record<string, unknown>,
    ) => Promise<void>;
    offer: (
      token: string,
      sdp: string,
    ) => {
      handling: Promise<boolean | void>;
      response: ReturnType<typeof createResponse>;
    };
    broadcast: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "talk-native-control-", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      const realtimeConfig: TalkRealtimeConfig = { provider: "openai", transport: "webrtc" };
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            voice: { agentDir: state.agentDir(AGENT_ID), workspace: state.workspaceDir },
            other: {},
          },
        },
        talk: { agentId: AGENT_ID, realtime: realtimeConfig },
        plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      };
      const registry = createEmptyPluginRegistry();
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const routes: HttpRoute[] = [];
      const lifecycles: PluginLifecycle[] = [];
      const broadcast = vi.fn();
      const profile = ensureProfileForEmail("native-control@example.test");
      const client = {
        ...sharingPolicyClient({
          user: profile.id,
          scopes: ["operator.read", "operator.talk"],
        }),
        connId: CONNECTION_ID,
      };
      const context = {
        getRuntimeConfig: () => config,
        getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
          new Set(!filter || filter(client) ? [CONNECTION_ID] : []),
        chatAbortControllers: new Map(),
        broadcastToConnIds: broadcast,
        logGateway: { warn: vi.fn() },
      } as unknown as GatewayRequestContext;
      let voiceSessionId: string | undefined;
      try {
        if (!openaiPlugin.register) {
          throw new Error("OpenAI did not expose its public registration entry");
        }
        openaiPlugin.register(
          createTestPluginApi({
            id: "openai",
            registrationMode: "full",
            config,
            runtime: createPluginRuntimeMock({ config: { current: () => config } }),
            registerRealtimeVoiceProvider: (provider) => {
              registry.realtimeVoiceProviders.push({
                pluginId: "openai",
                source: "test",
                provider,
              });
            },
            registerHttpRoute: (route) => routes.push(route),
            registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
          }),
        );
        const provider = registry.realtimeVoiceProviders.find(
          (entry) => entry.provider.id === "openai",
        )?.provider;
        // Choose the registered native family without reading an operator's model setting.
        const nativeModel = provider?.models?.find((model) => model.startsWith("gpt-live-"));
        if (!nativeModel) {
          throw new Error("OpenAI did not register a native realtime model");
        }
        realtimeConfig.model = nativeModel;
        setActivePluginRegistry(registry);
        const offerRoute = routes.find((route) => route.path === "/plugins/openai/realtime/calls");
        if (!offerRoute) {
          throw new Error("OpenAI did not register its realtime offer route");
        }
        await replaceSessionEntry(
          { agentId: AGENT_ID, sessionKey: SESSION_KEY },
          {
            sessionId: SESSION_ID,
            updatedAt: Date.now(),
            createdActor: { type: "human", source: "profile", id: profile.id },
          },
        );
        const call = async (
          method: keyof typeof talkClientHandlers,
          params: Record<string, unknown>,
        ) => {
          const respond = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: { type: "req", id: "native-control-request", method, params },
            respond,
            context,
            client,
            isWebchatConnect: () => false,
            extraHandlers: talkClientHandlers,
          });
          return requireSuccessfulReply(respond);
        };
        await run({
          create: async (negotiated) => {
            const result = await call("talk.client.create", {
              sessionKey: SESSION_KEY,
              mode: "realtime",
              transport: "webrtc",
              brain: "agent-consult",
              silenceDurationMs: 400,
              capabilities: negotiated ? ["gateway-control-v1"] : ["voice-transcript"],
            });
            voiceSessionId = requireString(result, "voiceSessionId");
            return result;
          },
          invoke: async (method, params) => {
            await call(method, { sessionKey: SESSION_KEY, voiceSessionId, ...params });
          },
          offer: (token, sdp) => {
            const request = Object.assign(createMockIncomingRequest([sdp]), {
              method: "POST",
              url: offerRoute.path,
              headers: { authorization: `Bearer ${token}`, "content-type": "application/sdp" },
            });
            const response = createResponse();
            const handling = Promise.resolve(offerRoute.handler(request, response.res));
            return { handling, response };
          },
          broadcast,
        });
      } finally {
        if (voiceSessionId) {
          await closeTalkClientGatewayControlSession({
            voiceSessionId,
            sessionKey: SESSION_KEY,
            connId: CONNECTION_ID,
          });
        }
        cleanupTalkConnection(CONNECTION_ID, context.logGateway);
        for (const lifecycle of lifecycles) {
          await lifecycle.cleanup?.({ reason: "disable" });
        }
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );
}

function talkEventTypes(broadcast: ReturnType<typeof vi.fn>): string[] {
  return broadcast.mock.calls.flatMap(([event, payload]) => {
    if (event !== "talk.event" || !isRecord(payload) || !isRecord(payload.talkEvent)) {
      return [];
    }
    return typeof payload.talkEvent.type === "string" ? [payload.talkEvent.type] : [];
  });
}

describe("native Talk through the public OpenAI plugin registration", () => {
  beforeEach(() => {
    upstream.sockets.length = 0;
    upstream.fetch.mockReset();
    upstream.fetch.mockImplementation(async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.hostname !== "chatgpt.com" || url.pathname !== "/backend-api/codex/realtime/calls") {
        throw new Error("Unexpected provider HTTP request");
      }
      return new Response("v=native-answer\r\n", {
        status: 201,
        headers: { Location: "/v1/live/rtc_native_test" },
      });
    });
    vi.stubGlobal("fetch", upstream.fetch);
    upstream.authConfigured.mockClear();
    upstream.resolveAuth.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("negotiates Gateway control and persists native sideband speech without client control", async () => {
    await withNativePlugin(async ({ create, offer, invoke, broadcast }) => {
      const result = await create(true);
      expect(result.clientControl).toEqual({ owner: "gateway" });
      expect(upstream.fetch).not.toHaveBeenCalled();
      const { handling, response } = offer(requireString(result, "clientSecret"), AUDIO_SDP);
      await vi.waitFor(() => expect(upstream.sockets).toHaveLength(1));
      expect(response.end).not.toHaveBeenCalled();
      const socket = upstream.sockets[0];
      if (!socket) {
        throw new Error("Missing native sideband");
      }
      socket.open();
      await handling;
      expect(response.res.statusCode).toBe(200);
      expect(talkEventTypes(broadcast).filter((type) => type === "session.ready")).toHaveLength(1);
      socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: "Hello voice" } });
      socket.serverEvent({
        type: "turn.done",
        turn: { role: "assistant", transcript: "Hello human" },
      });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      const messages = readSessionTranscriptMessageEvents({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      });
      expect(messages).toMatchObject([
        { event: { message: { role: "user", content: [{ type: "text", text: "Hello voice" }] } } },
        {
          event: {
            message: { role: "assistant", content: [{ type: "text", text: "Hello human" }] },
          },
        },
      ]);
      expect(talkEventTypes(broadcast)).not.toContain("turn.ended");
      await invoke("talk.client.close", {});
      expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED);
    });
  });

  it("keeps legacy native data-channel and client transcript ownership unchanged", async () => {
    await withNativePlugin(async ({ create, offer, invoke, broadcast }) => {
      const result = await create(false);
      expect(result.clientControl).toBeUndefined();
      const { handling, response } = offer(requireString(result, "clientSecret"), DATA_CHANNEL_SDP);
      await vi.waitFor(() => expect(upstream.sockets).toHaveLength(1));
      const socket = upstream.sockets[0];
      if (!socket) {
        throw new Error("Missing legacy native sideband");
      }
      socket.open();
      await handling;
      expect(response.res.statusCode).toBe(200);
      socket.serverEvent({
        type: "turn.done",
        turn: { role: "user", transcript: "Client-owned speech" },
      });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(0);
      expect(talkEventTypes(broadcast)).not.toContain("transcript.done");
      await invoke("talk.client.transcript", {
        entryId: "legacy-final",
        role: "user",
        text: "Client-owned speech",
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(1);
    });
  });
});
