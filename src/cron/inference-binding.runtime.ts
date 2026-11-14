import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { AuthProfileAuthorization } from "../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../agents/auth-profiles/authorization.js";
import { resolveSessionAuthSelection } from "../agents/auth-profiles/session-override.js";
import { ensureAuthProfileStoreAsync } from "../agents/auth-profiles/store-runtime.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  resolveCliExecutionAuthProfileId,
} from "../agents/cli-execution-auth.js";
import { resolveBundledCliBackendAuthPolicy } from "../agents/cli-runner/cli-backend-auth-policy.js";
import { resolveProviderModelAuthPolicy } from "../agents/model-auth-policy.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { isConfiguredKeyAuthSource } from "../agents/provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronInferenceBinding } from "./inference-binding.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
} from "./isolated-agent/model-selection.js";

/**
 * Capture a current owner; null means an explicit, validated native CLI account selection.
 * Local backport of openclaw#180677 (capture follows scheduled-model selection) and
 * openclaw#190904 (explicit native CLI account adoption) onto v2026.11.3.
 */
export async function captureCronInferenceBinding(params: {
  cfg: OpenClawConfig;
  agentId: string;
  model?: string;
  isGmailHook?: boolean;
  /** Creator conversation: supplies a same-provider account, never the scheduled model. */
  sessionEntry?: SessionEntry;
  /** Persistent `session:` execution target: supplies model overrides only. */
  executionSessionEntry?: Pick<SessionEntry, "modelOverride" | "providerOverride">;
  /** Execution target whose runtime a native adoption must match. */
  runtimeSessionEntry?: Parameters<typeof resolveSessionRuntimeOverrideForProvider>[0]["entry"];
  authorizeProfile?: (profileId: string, inherited: boolean) => Promise<(() => void) | undefined>;
  retainAuthorization?: (authority: AuthProfileAuthorization) => void;
}): Promise<CronInferenceBinding | null | undefined> {
  const owner = await resolveCronModelSelectionOwner({
    cfg: params.cfg,
    agentId: params.agentId,
    requiredAgentId: params.agentId,
  });
  const { config: cfg, agentId, agentDir, workspaceDir } = owner;
  // Capture follows the precedence the run uses: payload > Gmail hook > execution session >
  // subagent/agent > default. Creator authorization stays separate from the target model.
  const scheduled = await resolveCronModelSelection({
    cfg,
    owner,
    agentConfigOverride: resolveAgentConfig(cfg, agentId),
    agentId,
    agentDir,
    workspaceDir,
    payload: { kind: "agentTurn", message: "", model: params.model },
    sessionEntry: params.executionSessionEntry ?? {},
    isGmailHook: params.isGmailHook === true,
  });
  if (!scheduled.ok) {
    throw new Error(scheduled.error);
  }
  const model = {
    provider: scheduled.provider,
    modelId: scheduled.model,
    profileId: scheduled.configuredProfileId,
  };
  const cliExecutionProvider = resolveCliRuntimeExecutionProvider({
    cfg,
    agentId,
    provider: model.provider,
    modelId: model.modelId,
    authProfileId: model.profileId,
  });
  // Backends that never forward a stored profile own their login; nothing here can bind it.
  if (
    cliExecutionProvider &&
    !cliBackendAcceptsAuthProfileForwarding({
      provider: cliExecutionProvider,
      config: cfg,
      agentId,
    })
  ) {
    return undefined;
  }
  // A temporary creator model does not change the model an unpinned job will run.
  const creatorProvider =
    params.sessionEntry?.providerOverride ?? params.sessionEntry?.modelProvider;
  const creatorSession =
    creatorProvider && creatorProvider !== model.provider ? undefined : params.sessionEntry;
  let selection: Awaited<ReturnType<typeof resolveSessionAuthSelection>>;
  if (cliExecutionProvider) {
    // An explicit native login id belongs to the CLI owner. Keep it apart from a missing
    // selection: only this validated choice may release a stored account (null).
    const nativeProfileId =
      model.profileId &&
      resolveBundledCliBackendAuthPolicy(cliExecutionProvider)?.nativeAuthProfileIds?.includes(
        model.profileId,
      )
        ? model.profileId
        : undefined;
    if (nativeProfileId) {
      // Validate the runtime the next run inherits from its execution target.
      const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
        provider: model.provider,
        entry: params.runtimeSessionEntry,
        cfg,
      });
      if (sessionRuntime && sessionRuntime !== cliExecutionProvider) {
        throw new Error(
          `The selected native account is unavailable on automation runtime ${sessionRuntime}.`,
        );
      }
      return null;
    }
    // Record the stored account this backend would forward, chosen by the same selector
    // interactive CLI turns use; a native CLI login leaves no host account to record.
    const selectedProfileId = model.profileId ?? creatorSession?.authProfileOverride;
    const profileId = await resolveCliExecutionAuthProfileId({
      cliExecutionProvider,
      authProfileProvider: model.provider,
      config: cfg,
      agentDir,
      selected: selectedProfileId
        ? {
            authProfileId: selectedProfileId,
            authProfileIdSource:
              model.profileId ||
              creatorSession?.authProfileOverrideSource === "user" ||
              creatorSession?.authProfileOverrideSource === "user-link"
                ? "user"
                : "auto",
          }
        : undefined,
    });
    if (!profileId) {
      return undefined;
    }
    selection = {
      profileId,
      source: model.profileId ? "user" : "auto",
      routeRequirement: undefined,
    };
  } else {
    selection = await resolveSessionAuthSelection({
      cfg,
      agentId,
      agentDir,
      provider: model.provider,
      modelId: model.modelId,
      configuredProfileId: model.profileId ?? creatorSession?.authProfileOverride,
      sessionEntry: model.profileId ? undefined : creatorSession,
      isNewSession: false,
    });
  }
  const store = await ensureAuthProfileStoreAsync(agentDir, {
    profileId: selection?.profileId,
    allowKeychainPrompt: false,
    config: cfg,
  });
  if (!selection) {
    // With no compatible creator account, use the same route-aware planner as a fresh run.
    const [attempt] = prepareAgentRuntimeAuth({
      provider: model.provider,
      modelId: model.modelId,
      config: cfg,
      agentId,
      agentDir,
      authProfileStore: store,
    }).attempts;
    if (attempt?.kind !== "profile") {
      // A configured key keeps the job unbound, the same rule its runs follow.
      const source = attempt?.plan.credentialSource;
      if (source?.kind === "direct" && !isConfiguredKeyAuthSource(source)) {
        throw new Error(
          "Automation requires a stored inference account or a key in provider config. Select an account with model@profile.",
        );
      }
      return undefined;
    }
    selection = {
      profileId: attempt.profileId,
      source: attempt.plan.forwardedAuthProfileSource ?? "auto",
      routeRequirement: attempt.plan.modelRoute?.authRequirement,
    };
  }
  const assertSelectionCurrent = await params.authorizeProfile?.(
    selection.profileId,
    !model.profileId && selection.profileId === creatorSession?.authProfileOverride,
  );
  const credential = store.profiles[selection.profileId];
  if (!credential) {
    throw new Error("Automation requires an available stored inference account.");
  }
  const authRequirement =
    selection.routeRequirement ??
    resolveProviderModelAuthPolicy({
      provider: model.provider,
      mode: credential.type,
      authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
    }).authRequirement;
  if (!authRequirement) {
    throw new Error("Automation requires a supported stored inference authentication route.");
  }
  const authority = await captureAuthProfileAuthorization({
    profileId: selection.profileId,
    agentDir,
    cfg,
    assertCurrent: assertSelectionCurrent ?? (() => {}),
  });
  let retained = false;
  try {
    authority.assertCurrent();
    params.retainAuthorization?.(authority);
    retained = params.retainAuthorization !== undefined;
    return {
      version: 1,
      provider: model.provider,
      profileId: selection.profileId,
      authorizationId: authority.authorizationId,
      authRequirement,
      source:
        model.profileId ||
        creatorSession?.authProfileOverrideSource === "user" ||
        creatorSession?.authProfileOverrideSource === "user-link" ||
        (!creatorSession?.authProfileOverride && selection.source === "user")
          ? "user"
          : "auto",
    };
  } finally {
    if (!retained) {
      authority.dispose();
    }
  }
}

/** Reacquire the same owner, including its live revocation and replacement checks. */
export async function acquireCronInferenceAuthorization(params: {
  binding: CronInferenceBinding;
  cfg: OpenClawConfig;
  agentDir: string;
}) {
  const authority = await captureAuthProfileAuthorization({
    profileId: params.binding.profileId,
    agentDir: params.agentDir,
    cfg: params.cfg,
    assertCurrent() {},
  });
  if (authority.authorizationId !== params.binding.authorizationId) {
    authority.dispose();
    throw new Error(
      "Automation inference account was replaced. Explicitly select an authorized account again.",
    );
  }
  try {
    authority.assertCurrent();
    return authority;
  } catch (error) {
    authority.dispose();
    throw error;
  }
}
