import { listActiveEmbeddedRunSessionKeys } from "../agents/embedded-agent-runner/active-run-projections.js";
import { transitionMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-state.js";
import {
  listActiveReplyRunSessionKeys,
  replyRunRegistry,
} from "../auto-reply/reply/reply-run-registry.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveCronDeliverySessionKey } from "./session-target.js";
import type { CronJob } from "./types.js";

/** Background scheduling observes existing execution/recovery owners; it never interrupts them. */
export function isCronExecutionIdle(
  cfg: OpenClawConfig,
  job: CronJob,
  agentId: string,
  ownSessionKey?: string,
): boolean {
  const sessionKey =
    (job.sessionTarget === "main" ? undefined : resolveCronDeliverySessionKey(job)) ??
    resolveAgentMainSessionKey({ cfg, agentId });
  if (
    listActiveEmbeddedRunSessionKeys().some(
      (key) =>
        key !== ownSessionKey &&
        (key === sessionKey || parseAgentSessionKey(key)?.agentId === agentId),
    )
  ) {
    return false;
  }
  // Foreground admission wins before a backend has registered an embedded run.
  if (
    listActiveReplyRunSessionKeys().some(
      (key) =>
        key !== ownSessionKey &&
        parseAgentSessionKey(key)?.agentId === agentId &&
        replyRunRegistry.get(key)?.turnKind === "visible",
    )
  ) {
    return false;
  }
  const entry = loadSessionEntry({
    storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    sessionKey,
  });
  if (!entry) {
    return true;
  }
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const recovery = transitionMainSessionRecovery(entry, {
    kind: "inspect",
    lifecycleGeneration,
    sessionKey,
  });
  if (
    recovery.kind === "observed" &&
    (recovery.view.status === "blocked" || recovery.view.status === "recoverable")
  ) {
    return false;
  }
  return !entry.restartRecoveryRuns?.some(
    (run) =>
      run.runId === entry.restartRecoveryDeliveryRunId &&
      run.lifecycleGeneration === lifecycleGeneration,
  );
}
