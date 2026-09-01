import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
} from "../../agents/embedded-agent-runner/run-state.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveClientVoiceRunBinding } from "../../talk/client-voice-session.js";
import type { PreparedTalkSessionTarget } from "../talk-session-target.types.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveOwnedActiveTalkRunTarget(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  clientConnId?: string;
  sessionTarget: PreparedTalkSessionTarget;
  /** The shipped talk.client.steer RPC is session-wide; attached transports select their call. */
  scope: { kind: "session" } | { kind: "voice-session"; voiceSessionId: string };
  assertCurrent?: () => void;
}):
  | (NonNullable<Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"]> & {
      toolAuthoritySource?: "reply" | "attempt";
    })
  | null {
  const connId = normalizeOptionalString(params.clientConnId);
  if (!connId) {
    return null;
  }
  const { agentId, sessionKey, canonicalKey } = params.sessionTarget;
  for (const [runId, entry] of params.context.chatAbortControllers) {
    const generation = entry.lifecycleGeneration;
    if (!generation) {
      continue;
    }
    const signal = entry.controller.signal;
    const handle = ACTIVE_EMBEDDED_RUNS.get(entry.sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    // Pending calls remain classifiable, but an absent backend is not permission
    // to adopt a publisher that appears after this control was admitted.
    const isCurrent = (resolvedSessionId?: string) => {
      params.assertCurrent?.();
      if (params.scope.kind === "voice-session") {
        // Run bindings can move or retire during awaited control setup. They keep
        // the call's original key, not its canonical transcript-storage key.
        const binding = resolveClientVoiceRunBinding(runId);
        if (
          binding?.voiceSessionId !== params.scope.voiceSessionId ||
          binding.agentId !== agentId ||
          binding.sessionKey !== sessionKey
        ) {
          return false;
        }
      }
      return (
        params.context.chatAbortControllers.get(runId) === entry &&
        entry.agentId === agentId &&
        (entry.sessionKey === sessionKey || entry.sessionKey === canonicalKey) &&
        entry.ownerConnId === connId &&
        entry.kind !== "agent" &&
        entry.registrationCleanupRequested !== true &&
        (resolvedSessionId === undefined ||
          (entry.sessionId === resolvedSessionId &&
            handle !== undefined &&
            ACTIVE_EMBEDDED_RUNS.get(resolvedSessionId) === handle &&
            ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration)) &&
        entry.controller.signal === signal &&
        !signal.aborted &&
        entry.lifecycleGeneration === generation &&
        isAgentEventLifecycleGenerationCurrent(generation)
      );
    };
    if (isCurrent()) {
      return { runId, signal, isCurrent, toolAuthoritySource: registration?.toolAuthority?.source };
    }
  }
  return null;
}
