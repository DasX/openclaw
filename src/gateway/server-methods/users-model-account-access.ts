import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { isUserModelAuthProfileOwner } from "../../state/user-model-accounts.js";
import { getUserProfileListItem, resolveUserProfileId } from "../../state/user-profiles.js";
import {
  ModelAccountConnectAuthorityError,
  type ModelAccountConnectAction,
} from "../model-account-connect.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { resolveAuthenticatedProfileId } from "./users-profile-access.js";

/** Capture human authority once; every later privileged use rechecks this exact connection. */
export function prepareUserModelAccountAction(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">,
  profileId?: string,
  requiredScope: "operator.read" | "operator.write" = "operator.write",
): ModelAccountConnectAction {
  const { client, context } = options;
  const actor = resolveAuthenticatedProfileId(client);
  const target = profileId ?? actor;
  if (!target) {
    throw new ModelAccountConnectAuthorityError();
  }
  const owner = getUserProfileListItem(target).id;
  const assertCurrent = () => {
    // A copied identity, retained scopes, or a replacement socket cannot keep
    // the original action alive after disconnect or role invalidation.
    if (
      !client?.connId ||
      client.connect.role !== "operator" ||
      client.internal?.syntheticClient ||
      client.internal?.agentToolCaller ||
      client.internal?.agentRuntimeIdentity ||
      client.internal?.operatorRoleActor ||
      getGatewayToolCallerIdentity() ||
      options.signal?.aborted ||
      isGatewayClientProfilePending(client) ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId) ||
      resolveUserProfileId(owner) !== owner ||
      resolveAuthenticatedProfileId(client) !== actor
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
    const scope = actor === owner ? requiredScope : "operator.admin";
    const role = resolveOperatorRolePolicyForProfile(actor, context.getRuntimeConfig());
    const grants = [client.connect.scopes ?? [], ...(role ? [role.scopes] : [])];
    if (
      !grants.every((allowedScopes) =>
        roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes }),
      )
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  assertCurrent();
  return { owner, assertCurrent };
}

export type UserModelAccountSelection = { authProfileId: string; assertCurrent: () => void };

/** New personal selections require the human owner; inherited pins need no new selection. */
export function preparePersonalModelSelection(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">,
  model: string | null | undefined,
): UserModelAccountSelection | undefined {
  const authProfileId =
    typeof model === "string" ? splitTrailingAuthProfile(model).profile : undefined;
  if (!authProfileId || !isUserModelAuthProfileId(authProfileId)) {
    return undefined;
  }
  const action = prepareUserModelAccountAction(options);
  const assertCurrent = () => {
    action.assertCurrent();
    if (!isUserModelAuthProfileOwner({ profileId: action.owner, authProfileId })) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  assertCurrent();
  return { authProfileId, assertCurrent };
}
