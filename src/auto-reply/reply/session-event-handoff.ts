import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isAgentDeletionBlocked } from "../../agents/agent-lifecycle-registry.js";
import { resolveConfiguredAgentId } from "../../agents/agent-scope-config.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.read.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  getAgentRunContext,
  consumeCronNextCheckProposal,
} from "../../infra/agent-run-registry.js";
import type { SourceDeliveryOutcome } from "../../infra/outbound/source-delivery-plan.types.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  enqueueSystemEventEntry,
  type SystemEvent,
} from "../../infra/system-events.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";
import type {
  ScheduledSessionAutomation,
  SessionEventOutcome,
  SessionEventReceipt,
  SessionEventSource,
  SessionEventTarget,
} from "./session-event-contract.js";
export type {
  SessionEventReceipt,
  SessionEventSource,
  SessionEventTarget,
} from "./session-event-contract.js";

function getRuntimeConfig() {
  const cfg = getRuntimeConfigSnapshot();
  if (!cfg) {
    throw new Error(
      "Session event admission requires an initialized runtime config; start the Gateway and retry",
    );
  }
  return cfg;
}

function resolveEventKey(agentId: string, sessionKey: string) {
  const cfg = getRuntimeConfig();
  const raw = sessionKey.trim();
  const owner = parseAgentSessionKey(raw)?.agentId;
  if (!raw || (owner && owner !== agentId)) {
    throw new Error("Session event requires an exact session owned by its agent");
  }
  if (raw === "global") {
    return raw;
  }
  return canonicalizeMainSessionAlias({
    cfg,
    agentId,
    sessionKey: toAgentStoreSessionKey({ agentId, requestKey: raw, mainKey: cfg.session?.mainKey }),
  });
}

/** Capture at the producer's admission, before asynchronous work can outlive its session. */
export function captureSessionEventTargetForHost(
  requestedAgentId: string,
  requestedSessionKey: string,
): SessionEventTarget {
  const agentId = normalizeAgentId(requestedAgentId);
  const sessionKey = resolveEventKey(agentId, requestedSessionKey);
  const cfg = getRuntimeConfig();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const entry = loadExactSessionEntryReadOnly({ storePath, sessionKey })?.entry;
  const caller = getGatewayToolCallerIdentity();
  let toolsAllow: string[] | undefined;
  if (caller?.agentId === agentId && resolveEventKey(agentId, caller.sessionKey) === sessionKey) {
    if (
      caller.receiptAuthority?.() === false ||
      caller.approvalSignals?.some((signal) => signal.aborted)
    ) {
      throw new Error("Session event producer no longer owns its invocation");
    }
    if (caller.sessionEventToolsAllow) {
      if (
        caller.sessionEventToolsAllow.length > 512 ||
        caller.sessionEventToolsAllow.some((name) => name.length > 256)
      ) {
        throw new Error("Session event producer tool surface exceeds the supported bound");
      }
      toolsAllow = [...caller.sessionEventToolsAllow];
    }
  }
  return {
    agentId,
    sessionKey,
    storePath,
    toolsAllow,
    // Empty identity pins absence until normal admission creates the first session.
    sessionId: entry?.sessionId ?? "",
    lifecycleRevision: entry?.lifecycleRevision,
    generation: getAgentEventLifecycleGeneration(),
    deliveryContext: structuredClone(deliveryContextFromSession(entry)),
    settings: entry
      ? structuredClone({
          permissionMode: entry.permissionMode,
          toolOverrides: entry.toolOverrides,
        })
      : undefined,
  };
}

/** Validate the original destination; callers still own the live execution/delivery claim. */
export function assertSessionEventTargetCurrent(target: SessionEventTarget): void {
  target.assertCurrent?.();
  if (!target.agentId || !target.sessionKey) {
    throw new Error("Session event target has no original owner");
  }
  const cfg = getRuntimeConfig();
  resolveConfiguredAgentId(cfg, target.agentId);
  assertAgentRunLifecycleGenerationCurrent(target.generation);
  if (isAgentDeletionBlocked(target.agentId)) {
    throw new Error("Session event owner is being deleted");
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId });
  if (target.storePath && target.storePath !== storePath) {
    throw new Error("Session event destination store changed while its producer was running");
  }
  const current = loadExactSessionEntryReadOnly({
    storePath,
    sessionKey: target.sessionKey,
  })?.entry;
  if (
    (current?.sessionId ?? "") !== target.sessionId ||
    current?.lifecycleRevision !== target.lifecycleRevision
  ) {
    throw new Error(
      "Session event destination was reset or replaced while its producer was running",
    );
  }
}

/** Producer-owned occurrence; passive notices continue to use enqueueSystemEvent. */
export function enqueueSessionEventForHost(
  text: string,
  options: {
    agentId: string;
    sessionKey: string;
    source: SessionEventSource;
    contextKey?: string;
    deliveryContext?: DeliveryContext;
    abortSignal?: AbortSignal;
    expectedTarget?: SessionEventTarget;
    /** Durable producer commits its attempt only after normal turn adoption. */
    onAdopted?: () => void | Promise<void>;
    /** Transfer an existing producer-owned queue occurrence without duplicating its text. */
    occurrence?: SystemEvent;
    scheduledAutomation?: ScheduledSessionAutomation | undefined;
    /** An explicit silent job records its result without transport delivery. */
    deliver?: boolean;
    /** Host producer remains live through admission, execution and delivery. */
    assertCurrent?: () => void;
  },
): SessionEventReceipt {
  options.assertCurrent?.();
  options.expectedTarget?.assertCurrent?.();
  const cfg = getRuntimeConfig();
  const agentId = normalizeAgentId(options.agentId);
  resolveConfiguredAgentId(cfg, agentId);
  const sessionKey = resolveEventKey(agentId, options.sessionKey);
  const keyOwner = parseAgentSessionKey(sessionKey)?.agentId;
  if (!sessionKey || (keyOwner !== undefined && keyOwner !== agentId)) {
    throw new Error("Session event requires an exact session owned by its agent");
  }
  if (!text.trim() || (!options.scheduledAutomation && text.length > 4000)) {
    throw new Error("Session event text must contain 1–4000 characters");
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const expected = loadExactSessionEntryReadOnly({ storePath, sessionKey })?.entry;
  const generation = options.expectedTarget?.generation ?? getAgentEventLifecycleGeneration();
  if (
    options.expectedTarget &&
    ((options.expectedTarget.storePath && options.expectedTarget.storePath !== storePath) ||
      (options.expectedTarget.agentId && options.expectedTarget.agentId !== agentId) ||
      (options.expectedTarget.sessionKey && options.expectedTarget.sessionKey !== sessionKey) ||
      (expected?.sessionId ?? "") !== options.expectedTarget.sessionId ||
      expected?.lifecycleRevision !== options.expectedTarget.lifecycleRevision)
  ) {
    throw new Error(
      "Session event destination was reset or replaced while its producer was running",
    );
  }
  assertAgentRunLifecycleGenerationCurrent(generation);
  const route = structuredClone(
    options.deliveryContext ??
      options.expectedTarget?.deliveryContext ??
      (expected ? deliveryContextFromSession(expected) : undefined),
  );
  const controller = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal;
  if (options.occurrence && options.occurrence.text !== text.trim()) {
    throw new Error("Session event occurrence text changed before admission");
  }
  const occurrence =
    options.occurrence ??
    enqueueSystemEventEntry(
      text,
      withSystemEventOwner(
        {
          sessionKey,
          contextKey: options.contextKey,
          deliveryContext: route,
        },
        agentId,
      ),
      { allowDuplicate: true },
    );
  if (!occurrence?.id) {
    throw new Error("Session event was not enqueued: an identical occurrence is already pending");
  }
  const ownership = claimSystemEventTurn(sessionKey, occurrence, () => controller.abort(), agentId);
  if (!ownership) {
    throw new Error("Session event occurrence no longer available for admission");
  }
  const { promise: settled, resolve } = createDeferredCore<SessionEventOutcome>();
  let started = false;
  let deferred = false;
  let admissionDeferred = false;
  let operation: ReplyOperation | undefined;
  let replyRunRegistry: (typeof import("./reply-run-registry.js"))["replyRunRegistry"];
  let delivered = false;
  let deliveryAttempted = false;
  let deliveryAmbiguous = false;
  let deliverySuppressionReason: NormalizeReplySkipReason | undefined;
  let summary: string | undefined;
  let failure: string | undefined;
  let nextCheckMs: number | undefined;
  let sourceDeliveryOutcome: SourceDeliveryOutcome | undefined;
  let finished = false;
  let activeSessionId = expected?.sessionId;
  let activeLifecycleRevision = expected?.lifecycleRevision;
  const settings =
    options.expectedTarget?.settings ??
    (expected
      ? structuredClone({
          permissionMode: expected.permissionMode,
          toolOverrides: expected.toolOverrides,
        })
      : undefined);
  const jobTools = options.scheduledAutomation?.job.payload.toolsAllow;
  const producerTools = options.expectedTarget?.toolsAllow;
  const toolsAllow =
    jobTools && producerTools
      ? attachToolAllowlistIntersection([...jobTools], [[...producerTools]])
      : (jobTools ?? producerTools);
  const assertCurrent = () => {
    if (finished) {
      throw new Error("Session event occurrence is settled");
    }
    signal.throwIfAborted();
    options.assertCurrent?.();
    options.expectedTarget?.assertCurrent?.();
    assertAgentRunLifecycleGenerationCurrent(generation);
    const currentConfig = getRuntimeConfig();
    resolveConfiguredAgentId(currentConfig, agentId);
    if (resolveSessionStorePathCore(currentConfig.session?.store, { agentId }) !== storePath) {
      throw new Error("Session event destination store changed before settlement");
    }
    if (isAgentDeletionBlocked(agentId)) {
      throw new Error("Session event agent is being deleted");
    }
    options.scheduledAutomation?.assertCurrent();
    const current = loadExactSessionEntryReadOnly({ storePath, sessionKey })?.entry;
    if (
      settings &&
      JSON.stringify(settings) !==
        JSON.stringify({
          permissionMode: current?.permissionMode,
          toolOverrides: current?.toolOverrides,
        })
    ) {
      throw new Error(
        "Session event permission ceiling changed; enqueue fresh work from the current session",
      );
    }
    if (operation) {
      if (operation.abortSignal.aborted) {
        throw new Error("Session event admission no longer owns its destination");
      }
      if (
        replyRunRegistry.get(sessionKey) !== operation ||
        current?.sessionId !== operation.sessionId
      ) {
        throw new Error("Session event admission no longer owns its destination");
      } else if (
        current.sessionId === activeSessionId &&
        current.lifecycleRevision !== activeLifecycleRevision
      ) {
        throw new Error("Session event destination lifecycle changed before settlement");
      } else {
        activeSessionId = current.sessionId;
        activeLifecycleRevision = current.lifecycleRevision;
      }
      return;
    }
    if (
      current?.sessionId !== expected?.sessionId ||
      current?.lifecycleRevision !== expected?.lifecycleRevision
    ) {
      throw new Error("Session event destination was reset or replaced before execution");
    }
  };
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    const status = signal.aborted ? "cancelled" : failure ? "failed" : "completed";
    signal.removeEventListener("abort", onAbort);
    ownership.cancel();
    resolve({
      status,
      executionStarted: started,
      delivered,
      deliveryAttempted,
      deliveryAmbiguous,
      deliverySuppressionReason,
      admissionDeferred:
        !started &&
        (admissionDeferred ||
          (operation?.result?.kind === "aborted" &&
            operation.result.code === "aborted_for_supersession")),
      summary,
      nextCheckMs,
      sourceDeliveryOutcome,
      ...(failure ? { error: failure } : {}),
    });
  };
  const onAbort = () => {
    // Adopted work settles through its operation, including cancellation before model start.
    // Otherwise callers can release a cron reservation while its reply owner is still live.
    if (!operation) {
      finish();
    }
  };
  const deliver = async (payload: ReplyPayload, kind: "tool" | "block" | "final") => {
    assertCurrent();
    if (kind === "final" && payload.text) {
      summary ??= truncateUtf16Safe(payload.text, 2000);
    }
    if (options.deliver === false || options.expectedTarget?.deliver === false) {
      return;
    }
    if (kind === "final" && sourceDeliveryOutcome?.satisfiesSourceDelivery) {
      return;
    }
    if (!route?.channel || route.channel === INTERNAL_MESSAGE_CHANNEL) {
      // The normal transcript remains the result for internal/WebChat turns.
      // This is not evidence of a transport send.
      return;
    }
    const { isRoutableChannel, routeReply } = await import("./route-reply.js");
    assertCurrent();
    if (!isRoutableChannel(route?.channel) || !route?.to) {
      throw new Error(
        "Session event has no original external delivery route; inspect the session result or choose a delivery destination",
      );
    }
    deliveryAttempted = true;
    const deliveryConfig = getRuntimeConfig();
    const result = await routeReply({
      cfg: deliveryConfig,
      agentId,
      sessionKey,
      channel: route.channel,
      to: route.to,
      accountId: route.accountId,
      threadId: route.threadId,
      payload,
      replyKind: kind,
      abortSignal: signal,
      mirror: false,
      beforeDeliver: async () => {
        await options.scheduledAutomation?.beforeDeliver?.();
        assertCurrent();
        if (getRuntimeConfig() !== deliveryConfig) {
          throw new Error("Session event delivery policy changed before send");
        }
      },
      assertCurrent: () => {
        assertCurrent();
        if (getRuntimeConfig() !== deliveryConfig) {
          throw new Error("Session event delivery policy changed before send");
        }
        options.scheduledAutomation?.assertDeliveryCurrent?.();
      },
    });
    delivered ||= result.delivered;
    deliveryAmbiguous ||= result.ambiguous === true;
    if (!result.ok) {
      throw new Error(result.error ?? "Session event delivery failed");
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Completion outlives the producer's root and transcript writer. Keep its
  // independent root through settlement: queued dispatch returns before the
  // eventual execution and delivery finish.
  void runWithoutOwnedSessionTranscriptWrites(() =>
    runWithGatewayIndependentRootWorkContinuation(
      async () => {
        ({ replyRunRegistry } = await import("./reply-run-registry.js"));
        const { dispatchInboundMessageWithRoutedChannelDispatcher } =
          await import("../dispatch.js");
        assertCurrent();
        const result = await dispatchInboundMessageWithRoutedChannelDispatcher({
          cfg,
          ctx: {
            AgentId: agentId,
            SessionKey: sessionKey,
            Body: occurrence.text,
            BodyForAgent: occurrence.text,
            InternalTurnSource: "event",
            BodyForCommands: "",
            CommandBody: "",
            RawBody: "",
            CommandAuthorized: false,
            InputProvenance: { kind: "internal_system", sourceTool: options.source },
            Surface: route?.channel ?? INTERNAL_MESSAGE_CHANNEL,
            Provider: route?.channel ?? INTERNAL_MESSAGE_CHANNEL,
            OriginatingChannel: route?.channel,
            OriginatingTo: route?.to,
            AccountId: route?.accountId,
            MessageThreadId: route?.threadId,
            MessageSid: occurrence.id,
          },
          dispatcherOptions: {
            deliver: (payload, info) => deliver(payload, info.kind),
            onError: (error) => {
              failure = String(error);
            },
            onSkip: (_payload, info) => {
              if (info.kind === "final") {
                deliverySuppressionReason = info.reason;
              }
            },
          },
          replyOptions: {
            scheduledAutomation: options.scheduledAutomation,
            ...(options.scheduledAutomation
              ? {
                  sourceReplyDeliveryMode: "automatic" as const,
                  allowEmptyAssistantReplyAsSilent: true,
                }
              : {}),
            admittedSessionSettings: settings,
            toolsAllow,
            onDeliberateSilentTerminalReply: () => {
              deliverySuppressionReason = "silent";
            },
            ...(options.scheduledAutomation?.job.payload.kind === "agentTurn"
              ? {
                  modelOverride: options.scheduledAutomation.job.payload.model,
                  thinkingLevelOverride: options.scheduledAutomation.job.payload.thinking,
                  timeoutOverrideSeconds: options.scheduledAutomation.job.payload.timeoutSeconds,
                  bootstrapContextMode: options.scheduledAutomation.job.payload.lightContext
                    ? "lightweight"
                    : "full",
                }
              : {}),
            abortSignal: signal,
            expectedExistingSessionId: expected?.sessionId,
            pinExpectedExistingSession: expected !== undefined,
            queueModeOverride: "followup",
            suppressTyping: true,
            typingPolicy: "system_event",
            internalEventExecution: {
              onFailed: (error) => {
                failure ??= String(error);
              },
              onSuppressed: (reason) => {
                deliverySuppressionReason = reason === "silent" ? "silent" : undefined;
                if (reason === "aborted") {
                  failure ??= "Session event execution was aborted";
                }
              },
              beforeStart: async () => {
                await options.scheduledAutomation?.capacity?.resume(signal);
                assertCurrent();
                if (options.scheduledAutomation?.beforeStart?.() === false) {
                  admissionDeferred = true;
                  throw new Error(
                    "Automation admission deferred by its current window or foreground activity",
                  );
                }
              },
              onStarted: (runId) => {
                assertCurrent();
                if (!started && options.scheduledAutomation?.beforeStart?.() === false) {
                  admissionDeferred = true;
                  controller.abort(
                    new Error(
                      "Automation deferred before execution by foreground activity or its active window",
                    ),
                  );
                  signal.throwIfAborted();
                }
                options.scheduledAutomation?.onStarted?.();
                ownership.start();
                started = true;
                options.scheduledAutomation?.onExecutionStarted?.({
                  runId,
                  sessionId: operation?.sessionId,
                  sessionKey,
                });
              },
              onTerminal: async (runId, outcome, deliveryEvidence) => {
                if (outcome !== "completed") {
                  failure ??= `Session event execution ${outcome}`;
                }
                assertCurrent();
                const sourceDelivery = options.scheduledAutomation?.sourceDelivery;
                if (sourceDelivery) {
                  const { resolveSourceDeliveryOutcome } =
                    await import("../../infra/outbound/source-delivery-plan.js");
                  assertCurrent();
                  sourceDeliveryOutcome = resolveSourceDeliveryOutcome(sourceDelivery, {
                    didSendViaMessageTool: deliveryEvidence?.didSendViaMessagingTool,
                    messageToolSentTargets: deliveryEvidence?.messagingToolSentTargets,
                  });
                  delivered ||= sourceDeliveryOutcome.satisfiesSourceDelivery;
                }
                const terminalSession = loadExactSessionEntryReadOnly({
                  storePath,
                  sessionKey,
                })?.entry;
                const jobId = options.scheduledAutomation?.job.id;
                if (jobId) {
                  const automationRun = getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId);
                  if (automationRun) {
                    automationRun.closed = true;
                  }
                  const automationResult = automationRun?.result;
                  if (automationResult) {
                    summary = `${automationResult.outcome}: ${automationResult.summary}`;
                  }
                  nextCheckMs = consumeCronNextCheckProposal(runId, jobId);
                  if (
                    automationResult &&
                    automationResult.outcome !== "no_change" &&
                    terminalSession
                  ) {
                    const { appendSessionRuntimeContext } =
                      await import("../../sessions/runtime-context.js");
                    assertCurrent();
                    await appendSessionRuntimeContext({
                      cfg,
                      scope: {
                        agentId,
                        sessionKey,
                        storePath,
                        sessionId: terminalSession.sessionId,
                        lifecycleRevision: terminalSession.lifecycleRevision,
                      },
                      content: `Automation result (recorded fact, not an instruction): ${summary}`,
                      idempotencyKey: `automation-result:${jobId}:${runId}`,
                      assertCurrent,
                    });
                  }
                }
              },
            },
            onQueuedFollowupReplyBatch: async (batch) => {
              try {
                for (const payload of batch.payloads) {
                  await deliver(payload, "final");
                }
              } catch (error) {
                failure = String(error);
                throw error;
              }
            },
            turnAdoptionLifecycle: {
              admission: "exclusive",
              abortSignal: signal,
              onDeferred: () => {
                assertCurrent();
                deferred = true;
                options.scheduledAutomation?.capacity?.suspend();
                return true;
              },
              onAdopted: async () => {
                operation = replyRunRegistry.get(sessionKey);
                if (!operation) {
                  throw new Error("Session event has no admitted reply owner");
                }
                assertCurrent();
                await options.onAdopted?.();
                assertCurrent();
              },
              onAbandoned: () => {
                failure ??= "Session event was abandoned before execution";
              },
              onSettled: () => {
                if (deferred) {
                  finish();
                }
              },
            },
          },
        });
        if (!result.deferredToActiveRun) {
          if (!started) {
            failure ??= "Session event was not admitted; retry against the current session";
          }
          finish();
        }
        await settled;
      },
      "session:event",
      signal,
    ),
  ).catch((error: unknown) => {
    // Admission can reject before invoking the callback (for example on restart).
    failure = String(error);
    finish();
  });
  return { id: occurrence.id, cancel: ownership.cancel, settled };
}
