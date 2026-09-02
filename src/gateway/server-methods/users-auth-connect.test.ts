import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsersAuthConnectStartResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AuthProfileCredential, OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { UserProfileAuthLink } from "../../state/user-model-accounts.js";
import { getFreePort } from "../../test-utils/ports.js";
import { createModelAccountConnectService } from "../model-account-connect.js";
import { broadcastChatMetadataChanged } from "../server-chat-metadata-lifecycle.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { usersAuthConnectHandlers } from "./users-auth-connect.js";

const getUserProfileListItem = vi.hoisted(() => vi.fn());
const resolveUserProfileId = vi.hoisted(() => vi.fn());
const ensureProfileForEmail = vi.hoisted(() => vi.fn());
const connectUserModelAccount = vi.hoisted(() => vi.fn());
const listUserProfileAuthLinks = vi.hoisted(() => vi.fn());
const listUserModelAccounts = vi.hoisted(() => vi.fn());
const readUserModelAccountSummary = vi.hoisted(() => vi.fn());
const setUserProfileAuthLink = vi.hoisted(() => vi.fn());
const registerSecretValueForRedaction = vi.hoisted(() => vi.fn());
const createModelAccountAuthorization = vi.hoisted(() => vi.fn());
const exchange = vi.hoisted(() => vi.fn());

vi.mock("../../state/user-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/user-profiles.js")>();
  return {
    ...actual,
    ensureProfileForEmail,
    getUserProfileListItem,
    resolveUserProfileId,
    getUserProfileRole: () => null,
  };
});
vi.mock("../../state/user-model-accounts.js", () => ({
  connectUserModelAccount,
  listUserProfileAuthLinks,
  listUserModelAccounts,
  readUserModelAccountSummary,
  setUserProfileAuthLink,
}));
vi.mock("../../logging/secret-redaction-registry.js", () => ({ registerSecretValueForRedaction }));
vi.mock("../../plugin-sdk/facade-runtime.js", () => ({
  loadActivatedBundledPluginPublicSurfaceModuleSync: () => ({ createModelAccountAuthorization }),
}));

type TestClient = GatewayClient & { connId: string; invalidated: boolean };
type ConnectTestContext = Pick<
  GatewayRequestContext,
  | "broadcast"
  | "logGateway"
  | "modelAccountConnectService"
  | "getRuntimeConfig"
  | "getClientConnIds"
>;
const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  accountId: "workspace-1",
  expires: 123,
};
const authorized = {
  status: "authorized" as const,
  credential,
  matchesCredential: (_existing: AuthProfileCredential) => true,
};
const SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;
const broadcast = vi.fn();
const warn = vi.fn();
let service: ReturnType<typeof createModelAccountConnectService>;
let context: ConnectTestContext;
let config: OpenClawConfig;
let clients: Set<TestClient>;
let self: TestClient;
let callbackUri: string;
let nextFlow: number;
let writes: AuthProfileCredential[];
let linksByOwner: Map<string, UserProfileAuthLink[]>;

function createClient(profileId = "profile-1", scopes = ["operator.write"]): TestClient {
  const client: TestClient = {
    connId: `connection-${clients.size + 1}`,
    invalidated: false,
    authenticatedUserProfile: { profileId, displayName: "Ada", hasAvatar: false, updatedAt: 1 },
    connect: {
      role: "operator",
      scopes,
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", version: "1", platform: "test" },
    },
  };
  clients.add(client);
  return client;
}

async function rpc(method: string, params: Record<string, unknown>, client: TestClient = self) {
  const respond = vi.fn();
  await expectDefined(
    usersAuthConnectHandlers[method],
    `${method} test invariant`,
  )({
    req: { type: "req", id: "connect-test", method, params },
    client,
    context: context as GatewayRequestContext,
    params,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}
async function startFlow(
  profileId = "profile-1",
  client = self,
): Promise<UsersAuthConnectStartResult> {
  const respond = await rpc("users.authConnect.start", { profileId, provider: "openai" }, client);
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ connectId: expect.any(String) }),
  );
  return respond.mock.calls[0]?.[1] as UsersAuthConnectStartResult;
}
function redirect(flow: UsersAuthConnectStartResult, state?: string): string {
  const url = new URL(callbackUri);
  url.searchParams.set("code", "synthetic-code");
  url.searchParams.set("state", state ?? new URL(flow.url).searchParams.get("state")!);
  return url.toString();
}
function complete(flow: UsersAuthConnectStartResult, profileId = "profile-1", client = self) {
  return rpc(
    "users.authConnect.complete",
    { profileId, connectId: flow.connectId, redirectInput: redirect(flow) },
    client,
  );
}
async function status(flow: UsersAuthConnectStartResult, profileId = "profile-1", client = self) {
  const respond = await rpc(
    "users.authConnect.status",
    { profileId, connectId: flow.connectId },
    client,
  );
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1];
}

beforeEach(async () => {
  vi.clearAllMocks();
  broadcast.mockReset();
  config = {};
  clients = new Set();
  self = createClient();
  nextFlow = 0;
  writes = [];
  linksByOwner = new Map();
  listUserProfileAuthLinks.mockImplementation((owner: string) => linksByOwner.get(owner) ?? []);
  listUserModelAccounts.mockReset().mockReturnValue({ accounts: [] });
  readUserModelAccountSummary.mockReset();
  setUserProfileAuthLink
    .mockReset()
    .mockImplementation(
      (params: {
        profileId: string;
        provider: string;
        authProfileId: string;
        assertCurrent: () => void;
      }) => {
        params.assertCurrent();
        const links = [
          { provider: params.provider, authProfileId: params.authProfileId, updatedAt: 2 },
        ];
        linksByOwner.set(params.profileId, links);
        return links;
      },
    );
  callbackUri = `http://127.0.0.1:${await getFreePort()}/auth/callback`;
  getUserProfileListItem.mockImplementation((id: string) => ({
    id,
    displayName: "Ada",
    emails: [],
  }));
  resolveUserProfileId.mockImplementation((id: string) => id);
  ensureProfileForEmail.mockReturnValue({ id: "profile-1" });
  createModelAccountAuthorization.mockImplementation(async () => {
    const state = `state-${++nextFlow}`;
    return {
      url: `https://auth.example.test/authorize?state=${state}`,
      state,
      redirectUri: callbackUri,
      exchange,
    };
  });
  exchange.mockResolvedValue(authorized);
  connectUserModelAccount.mockImplementation(
    (params: {
      ownerProfileId: string;
      credential: AuthProfileCredential;
      assertCurrent: () => void;
    }) => {
      params.assertCurrent();
      writes.push(params.credential);
      const authProfileId = `personal:${params.ownerProfileId}:account-1`;
      const links = [
        ...(linksByOwner.get(params.ownerProfileId) ?? []).filter(
          (link) => link.provider !== params.credential.provider,
        ),
        { provider: params.credential.provider, authProfileId, updatedAt: 1 },
      ];
      linksByOwner.set(params.ownerProfileId, links);
      return { authProfileId, links };
    },
  );
  service = createModelAccountConnectService({
    onChanged: () => broadcastChatMetadataChanged(context),
  });
  context = {
    broadcast,
    logGateway: { ...createSubsystemLogger("gateway"), warn },
    modelAccountConnectService: service,
    getRuntimeConfig: () => config,
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients]
          .filter((client) => !client.invalidated && (!filter || filter(client)))
          .map((client) => client.connId),
      ),
  };
});
afterEach(async () => {
  await service.stop();
  vi.restoreAllMocks();
});

describe("users model-account connection lifecycle", () => {
  it("lists the authenticated person's account page without accepting an implicit different owner", async () => {
    const accounts = [
      {
        authProfileId: "personal:profile-1:saved",
        provider: "openai",
        label: "Saved account",
        authType: "oauth",
        selected: false,
      },
    ];
    listUserModelAccounts.mockReturnValue({ accounts, nextCursor: "personal:profile-1:saved" });
    expect(
      await rpc("users.listModelAccounts", { cursor: "personal:profile-1:before" }),
    ).toHaveBeenCalledWith(true, {
      profileId: "profile-1",
      accounts,
      nextCursor: "personal:profile-1:saved",
      links: [],
    });
    expect(listUserModelAccounts).toHaveBeenCalledWith({
      profileId: "profile-1",
      cursor: "personal:profile-1:before",
    });
    listUserModelAccounts.mockClear();
    expect(
      await rpc("users.listModelAccounts", { profileId: "profile-other" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    expect(listUserModelAccounts).not.toHaveBeenCalled();
  });

  it("selects a retained owned account and cancels an older sign-in without rewriting credentials", async () => {
    const flow = await startFlow();
    readUserModelAccountSummary.mockReturnValue({
      provider: "openai",
      authProfileId: "personal:profile-1:saved",
    });
    expect(
      await rpc("users.selectModelAccount", { authProfileId: "personal:profile-1:saved" }),
    ).toHaveBeenCalledWith(true, {
      links: [{ provider: "openai", authProfileId: "personal:profile-1:saved", updatedAt: 2 }],
    });
    expect(readUserModelAccountSummary).toHaveBeenCalledWith({
      profileId: "profile-1",
      authProfileId: "personal:profile-1:saved",
    });
    expect(await status(flow)).toEqual({ status: "cancelled" });
    expect(await complete(flow)).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(writes).toEqual([]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      {},
      { dropIfSlow: true },
    );
  });

  it.each(["unavailable account", "disconnected", "agent caller"] as const)(
    "refuses personal selection for %s without changing the default",
    async (reason) => {
      if (reason === "disconnected") {
        clients.delete(self);
      } else if (reason === "agent caller") {
        self.internal = { ...self.internal, syntheticClient: true };
      }
      expect(
        await rpc("users.selectModelAccount", { authProfileId: "personal:profile-other:account" }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: reason === "unavailable account" ? "INVALID_REQUEST" : "FORBIDDEN",
        }),
      );
      expect(setUserProfileAuthLink).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    },
  );

  it("records paste completion once and returns the same terminal result on replay", async () => {
    const flow = await startFlow();
    const respond = await complete(flow);
    expect(respond).toHaveBeenCalledWith(true, {
      status: "connected",
      authProfileId: "personal:profile-1:account-1",
      links: [{ provider: "openai", authProfileId: "personal:profile-1:account-1", updatedAt: 1 }],
    });
    expect(await status(flow)).toEqual(respond.mock.calls[0]?.[1]);
    expect((await complete(flow)).mock.calls).toEqual(respond.mock.calls);
    expect(writes).toEqual([credential]);
    expect(exchange).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      {},
      { dropIfSlow: true },
    );
    expect(registerSecretValueForRedaction).toHaveBeenCalledWith(redirect(flow));
    expect(registerSecretValueForRedaction.mock.invocationCallOrder[0]).toBeLessThan(
      exchange.mock.invocationCallOrder[0]!,
    );
  });

  it("reports the actual persisted result after a real loopback callback", async () => {
    const flow = await startFlow();
    expect(flow.autoCallback).toBe(true);
    const callback = await fetch(redirect(flow));
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("Authorization received");
    await vi.waitFor(async () => expect(await status(flow)).toMatchObject({ status: "connected" }));
    expect(writes).toEqual([credential]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      {},
      { dropIfSlow: true },
    );
    expect(registerSecretValueForRedaction).toHaveBeenCalledWith("synthetic-code");
  });

  it.each([
    { action: "status", change: "unlink", provider: "openai", links: [] },
    {
      action: "complete",
      change: "manual relink",
      provider: "openai",
      links: [{ provider: "openai", authProfileId: "openai:shared", updatedAt: 2 }],
    },
    {
      action: "cancel",
      change: "another provider connection",
      provider: "anthropic",
      links: [
        { provider: "openai", authProfileId: "personal:profile-1:account-1", updatedAt: 1 },
        { provider: "anthropic", authProfileId: "personal:profile-1:account-2", updatedAt: 2 },
      ],
    },
  ])(
    "reports current links after $change when replaying $action",
    async ({ action, provider, links }) => {
      const flow = await startFlow();
      await fetch(redirect(flow));
      await vi.waitFor(() => expect(writes).toEqual([credential]));
      // A link mutation can commit after OAuth but before the browser observes its outcome.
      linksByOwner.set("profile-1", links);
      service.supersede("profile-1", provider);

      expect(
        await rpc(`users.authConnect.${action}`, {
          profileId: "profile-1",
          connectId: flow.connectId,
          ...(action === "complete" ? { redirectInput: redirect(flow) } : {}),
        }),
      ).toHaveBeenCalledWith(true, {
        status: "connected",
        authProfileId: "personal:profile-1:account-1",
        links,
      });
      expect(writes).toEqual([credential]);
      expect(exchange).toHaveBeenCalledOnce();
    },
  );

  it("rejects unmatched callback and paste states without consuming the pending operation", async () => {
    const flow = await startFlow();
    expect((await fetch(redirect(flow, "wrong-state"))).status).toBe(400);
    for (const redirectInput of [redirect(flow, "wrong-state"), "synthetic-code"]) {
      expect(
        await rpc("users.authConnect.complete", {
          profileId: "profile-1",
          connectId: flow.connectId,
          redirectInput,
        }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(await status(flow)).toEqual({ status: "pending" });
    expect(exchange).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("contains callback persistence failures and records a redacted terminal outcome", async () => {
    connectUserModelAccount.mockImplementationOnce(() => {
      throw new Error("private persistence detail");
    });
    const flow = await startFlow();
    const callback = await fetch(redirect(flow));
    expect(callback.status).toBe(200);
    expect(await callback.text()).not.toContain("private persistence detail");
    await vi.waitFor(async () =>
      expect(await status(flow)).toEqual({ status: "failed", reason: "unavailable" }),
    );
    expect(writes).toEqual([]);
  });

  it.each(["exchange", "identity"] as const)(
    "records provider %s failure without storing credentials",
    async (reason) => {
      exchange.mockResolvedValueOnce({ status: "failed", reason });
      const flow = await startFlow();
      expect(await complete(flow)).toHaveBeenCalledWith(true, { status: "failed", reason });
      expect(await status(flow)).toEqual({ status: "failed", reason });
      expect(writes).toEqual([]);
    },
  );

  it.each([
    { transport: "paste", scopes: ["operator.write"], profileId: "profile-1" },
    { transport: "callback", scopes: ["operator.write"], profileId: "profile-1" },
    { transport: "paste", scopes: ["operator.admin"], profileId: "profile-other" },
    { transport: "callback", scopes: ["operator.admin"], profileId: "profile-other" },
  ])(
    "rejects invalidated $scopes authority during $transport exchange",
    async ({ transport, scopes, profileId }) => {
      const client = createClient("profile-1", scopes);
      const deferred = createDeferredCore<typeof authorized>();
      exchange.mockReturnValueOnce(deferred.promise);
      const flow = await startFlow(profileId, client);
      const completion =
        transport === "paste" ? complete(flow, profileId, client) : fetch(redirect(flow));
      await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
      // Real revocation invalidates the retained client without rewriting its identity or scopes.
      client.invalidated = true;
      deferred.resolve(authorized);
      await completion;
      const observer = createClient("profile-1", scopes);
      await vi.waitFor(async () =>
        expect(await status(flow, profileId, observer)).toEqual({
          status: "failed",
          reason: "authority",
        }),
      );
      expect(writes).toEqual([]);
    },
  );

  it("intersects current role policy with the original socket grant after exchange", async () => {
    const writer: GatewayOperatorRoleDefinition = {
      agents: "*",
      scopes: ["operator.write"],
      sessions: { others: "none" },
    };
    config = { gateway: { roles: { default: "writer", definitions: { writer } } } };
    const deferred = createDeferredCore<typeof authorized>();
    exchange.mockReturnValueOnce(deferred.promise);
    const flow = await startFlow();
    const completion = complete(flow);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    writer.scopes = ["operator.read"];
    deferred.resolve(authorized);
    expect(await completion).toHaveBeenCalledWith(true, { status: "failed", reason: "authority" });
    expect(writes).toEqual([]);
  });

  it("cancels authority when the initiating socket disconnects even if the owner reconnects", async () => {
    const flow = await startFlow();
    clients.delete(self);
    const replacement = createClient();
    expect(await status(flow, "profile-1", replacement)).toEqual({
      status: "failed",
      reason: "authority",
    });
    expect(await complete(flow, "profile-1", replacement)).toHaveBeenCalledWith(true, {
      status: "failed",
      reason: "authority",
    });
    expect(exchange).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("fences a merged or removed owner before persistence", async () => {
    const deferred = createDeferredCore<typeof authorized>();
    exchange.mockReturnValueOnce(deferred.promise);
    const flow = await startFlow();
    const completion = complete(flow);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    resolveUserProfileId.mockImplementation((id: string) =>
      id === "profile-1" ? "profile-merged" : id,
    );
    deferred.resolve(authorized);
    expect(await completion).toHaveBeenCalledWith(true, { status: "failed", reason: "authority" });
    expect(writes).toEqual([]);
  });

  it("aborts a cancelled exchange and never lets a late credential replace that result", async () => {
    const deferred = createDeferredCore<typeof authorized>();
    exchange.mockReturnValueOnce(deferred.promise);
    const flow = await startFlow();
    const completion = complete(flow);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    const signal: AbortSignal = exchange.mock.calls[0]![1];
    expect(
      await rpc("users.authConnect.cancel", { profileId: "profile-1", connectId: flow.connectId }),
    ).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(signal.aborted).toBe(true);
    deferred.resolve(authorized);
    expect(await completion).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(await status(flow)).toEqual({ status: "cancelled" });
    expect(writes).toEqual([]);
  });

  it("retires replaced operations without allowing an old cancel to affect the replacement", async () => {
    const deferred = createDeferredCore<typeof authorized>();
    exchange.mockReturnValueOnce(deferred.promise);
    const first = await startFlow();
    const completion = complete(first);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    const replacement = await startFlow();
    expect(
      await rpc("users.authConnect.cancel", { profileId: "profile-1", connectId: first.connectId }),
    ).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(await status(replacement)).toEqual({ status: "pending" });
    deferred.resolve(authorized);
    expect(await completion).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(await complete(replacement)).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "connected" }),
    );
    expect(writes).toEqual([credential]);
  });

  it("expires an in-flight exchange at use time before its timer is dispatched", async () => {
    const deferred = createDeferredCore<typeof authorized>();
    exchange.mockReturnValueOnce(deferred.promise);
    const flow = await startFlow();
    const completion = complete(flow);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    vi.spyOn(Date, "now").mockReturnValue(flow.expiresAtMs + 1);
    deferred.resolve(authorized);
    expect(await completion).toHaveBeenCalledWith(true, { status: "expired" });
    expect(writes).toEqual([]);
  });

  it("stops without waiting for an uncooperative provider and fences its late completion", async () => {
    const deferred = createDeferredCore<typeof authorized>();
    exchange.mockReturnValueOnce(deferred.promise);
    const flow = await startFlow();
    const completion = complete(flow);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    await service.stop();
    expect((exchange.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    service = createModelAccountConnectService();
    context.modelAccountConnectService = service;
    expect(await status(flow)).toEqual({ status: "expired" });
    deferred.resolve(authorized);
    expect(await completion).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(writes).toEqual([]);
  });

  it("lets explicit link changes supersede an exchange before it can undo the newer selection", async () => {
    const deferred = createDeferredCore<typeof authorized>();
    exchange.mockReturnValueOnce(deferred.promise);
    const flow = await startFlow();
    const completion = complete(flow);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    service.supersede("profile-1", "openai");
    deferred.resolve(authorized);
    expect(await completion).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(writes).toEqual([]);
  });

  it("uses the paste route when another process owns the loopback callback port", async () => {
    const listener = createServer((_request, response) => response.end("unrelated listener"));
    await new Promise<void>((resolve) => {
      listener.listen(Number(new URL(callbackUri).port), "127.0.0.1", resolve);
    });
    try {
      const flow = await startFlow();
      expect(flow.autoCallback).toBe(false);
      expect(await complete(flow)).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "connected" }),
      );
      expect(writes).toEqual([credential]);
    } finally {
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
      });
    }
  });

  it("bounds concurrent sign-ins and recovers capacity after cancellation", async () => {
    const admin = createClient("profile-admin", ["operator.admin"]);
    const flows = [];
    for (let index = 0; index < 8; index++) {
      flows.push(await startFlow(`profile-${index}`, admin));
    }
    expect(
      await rpc("users.authConnect.start", { profileId: "profile-9", provider: "openai" }, admin),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "UNAVAILABLE" }));
    await rpc(
      "users.authConnect.cancel",
      { profileId: "profile-0", connectId: flows[0]!.connectId },
      admin,
    );
    expect((await startFlow("profile-9", admin)).connectId).toBeTruthy();
  });

  it("stores a validated Claude token through the same owner-scoped commit boundary", async () => {
    const respond = await rpc("users.authConnect.token", {
      profileId: "profile-1",
      provider: "anthropic",
      token: SETUP_TOKEN,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      authProfileId: "personal:profile-1:account-1",
      links: [
        { provider: "anthropic", authProfileId: "personal:profile-1:account-1", updatedAt: 1 },
      ],
    });
    expect(registerSecretValueForRedaction).toHaveBeenCalledWith(SETUP_TOKEN);
    expect(writes).toEqual([{ type: "token", provider: "anthropic", token: SETUP_TOKEN }]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      {},
      { dropIfSlow: true },
    );
    const commit: Parameters<
      typeof import("../../state/user-model-accounts.js").connectUserModelAccount
    >[0] = connectUserModelAccount.mock.calls[0]![0];
    const matchesCredential = expectDefined(commit.matchesCredential, "token reuse policy");
    expect(matchesCredential({ type: "token", provider: "anthropic", token: SETUP_TOKEN })).toBe(
      true,
    );
    expect(
      matchesCredential({ type: "token", provider: "anthropic", token: `${SETUP_TOKEN}changed` }),
    ).toBe(false);
  });

  it("rejects malformed setup tokens before persistence without echoing the token", async () => {
    expect(
      await rpc("users.authConnect.token", {
        profileId: "profile-1",
        provider: "anthropic",
        token: "sk-ant-oat01-short",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(registerSecretValueForRedaction).toHaveBeenCalledWith("sk-ant-oat01-short");
    expect(writes).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["oauth", "token"] as const)(
    "keeps a committed %s account connected when notification fails",
    async (kind) => {
      broadcast.mockImplementation(() => {
        throw new Error("socket notification failed");
      });
      if (kind === "oauth") {
        const flow = await startFlow();
        expect(await complete(flow)).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "connected" }),
        );
        expect(await status(flow)).toMatchObject({ status: "connected" });
      } else {
        expect(
          await rpc("users.authConnect.token", {
            profileId: "profile-1",
            provider: "anthropic",
            token: SETUP_TOKEN,
          }),
        ).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ authProfileId: "personal:profile-1:account-1" }),
        );
      }
      expect(writes).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith("chat metadata change notification failed");
    },
  );

  it("requires self or current admin authority to connect another profile", async () => {
    expect(
      await rpc("users.authConnect.start", { profileId: "profile-other", provider: "openai" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    expect(createModelAccountAuthorization).not.toHaveBeenCalled();
  });

  it("validates params before consulting identity, state, or provider code", async () => {
    expect(
      await rpc("users.authConnect.start", {
        profileId: "profile-1",
        provider: "openai",
        unexpected: true,
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(getUserProfileListItem).not.toHaveBeenCalled();
    expect(createModelAccountAuthorization).not.toHaveBeenCalled();
  });
});
