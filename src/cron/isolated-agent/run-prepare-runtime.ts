/** Lazy preparation runtimes and session lifecycle helpers for cron runs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { hasAnyAuthProfileStoreSource } from "../../agents/auth-profiles/source-check.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type {
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
  CronStoredJob,
} from "../types.js";
import type { createPersistCronSessionEntry, MutableCronSession } from "./run-session-state.js";
import { logWarn } from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

export type RunCronAgentTurnParams = {
  assertCurrent?: () => void;
  cfg: OpenClawConfig;
  deps: CliDeps;
  job: CronStoredJob;
  message: string;
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  sessionKey: string;
  agentId?: string;
  lane?: string;
};

export function resolveCronAgentTurnMessage(input: RunCronAgentTurnParams): string {
  if (input.job.payload.kind === "agentTurn") {
    return input.job.payload.message;
  }
  return input.message;
}

export type WithRunSession = (
  result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
) => RunCronAgentTurnResult;

const sessionAccessorRuntimeLoader = createLazyImportLoader(
  () => import("../../config/sessions/session-accessor.js"),
);
const cronExternalContentRuntimeLoader = createLazyImportLoader(
  () => import("./run-external-content.runtime.js"),
);
const cronAuthProfileRuntimeLoader = createLazyImportLoader(
  () => import("./run-auth-profile.runtime.js"),
);
/** Revalidate the captured caller inside the session accessor's synchronous write edge. */
export function createCronSessionRowPersister(
  agentId: string,
  assertCurrent?: () => void,
): Parameters<typeof createPersistCronSessionEntry>[0]["persistSessionEntry"] {
  return async ({ storePath, sessionKey, fallbackEntry, resetBoundaryReason, update }) => {
    const { applySessionEntryLifecycleMutation, patchSessionEntryCore } =
      await sessionAccessorRuntimeLoader.load();
    if (resetBoundaryReason) {
      await applySessionEntryLifecycleMutation({
        activeSessionKey: sessionKey,
        agentId,
        storePath,
        upserts: [
          {
            sessionKey,
            resetBoundary: { context: "preserve-tail", reason: resetBoundaryReason },
            buildEntry: ({ currentEntry }) => {
              assertCurrent?.();
              return update(currentEntry);
            },
          },
        ],
        skipMaintenance: true,
      });
      return;
    }
    // Guarded replace reads the freshest row so lifecycle claims reject stale owners.
    await patchSessionEntryCore(
      { storePath, sessionKey, agentId },
      (_entry, context) => {
        assertCurrent?.();
        return update(context.existingEntry);
      },
      { fallbackEntry, replaceEntry: true },
    );
  };
}

export async function loadCronExternalContentRuntime() {
  return await cronExternalContentRuntimeLoader.load();
}

async function loadCronAuthProfileRuntime() {
  return await cronAuthProfileRuntimeLoader.load();
}

function hasConfiguredAuthProfiles(cfg: OpenClawConfig): boolean {
  return (
    Boolean(cfg.auth?.profiles && Object.keys(cfg.auth.profiles).length > 0) ||
    Boolean(cfg.auth?.order && Object.keys(cfg.auth.order).length > 0)
  );
}

/**
 * Resolves the run's auth profile, skipping the lazy runtime entirely when no
 * override, configured profile, or store source exists for it to find. Auth
 * resolution may mutate session state, so it uses the store and key that
 * persistence will write.
 */
export async function resolveCronAuthSelection(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  configuredProfileId?: string;
  harnessRuntime: Parameters<
    CronAuthProfileRuntime["resolveSessionAuthSelection"]
  >[0]["harnessRuntime"];
  agentDir: string;
  cronSession: MutableCronSession;
  sessionKey: string;
  isNewSession: boolean;
}) {
  const hasSessionOverride = Boolean(params.cronSession.sessionEntry.authProfileOverride?.trim());
  if (
    !hasSessionOverride &&
    !hasConfiguredAuthProfiles(params.cfg) &&
    !hasAnyAuthProfileStoreSource(params.agentDir)
  ) {
    return undefined;
  }
  const runtime = await loadCronAuthProfileRuntime();
  return await runtime.resolveSessionAuthSelection({
    cfg: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    ...(params.configuredProfileId ? { configuredProfileId: params.configuredProfileId } : {}),
    harnessRuntime: params.harnessRuntime,
    agentDir: params.agentDir,
    sessionEntry: params.cronSession.sessionEntry,
    sessionStore: params.cronSession.store,
    sessionKey: params.sessionKey,
    storePath: params.cronSession.storePath,
    isNewSession: params.isNewSession,
  });
}

type CronAuthProfileRuntime = Awaited<ReturnType<typeof loadCronAuthProfileRuntime>>;

export async function retireRolledCronSessionMcpRuntime(params: {
  job: CronJob;
  cronSession: MutableCronSession;
}) {
  if (params.job.sessionTarget === "isolated") {
    return;
  }
  const previousSessionId = normalizeOptionalString(params.cronSession.previousSessionId);
  const currentSessionId = normalizeOptionalString(params.cronSession.sessionEntry.sessionId);
  if (!previousSessionId || previousSessionId === currentSessionId) {
    return;
  }
  await retireSessionMcpRuntime({
    sessionId: previousSessionId,
    reason: "cron-session-rollover",
    onError: (error, sessionId) => {
      logWarn(
        `[cron:${params.job.id}] Failed to dispose retired bundle MCP runtime for session ${sessionId}: ${String(error)}`,
      );
    },
  });
}
