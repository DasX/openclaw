/** Scheduled shared-session turns use the normal reply admission and delivery owners. */
import { sliceToolResultTextToBudget } from "../agents/embedded-agent-runner/tool-result-text-budget.js";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  enqueueSessionEventForHost as enqueueSessionEvent,
} from "../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareAutomationSystemEvents } from "../infra/system-events.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { isCronWithinActiveHours } from "./active-hours.js";
import { isCronExecutionIdle } from "./execution-idle.js";
import {
  buildCronDeliveryTrace,
  resolveCronDeliveryContext,
} from "./isolated-agent/run-delivery-trace.js";
import { appendCronUnattendedRunPreamble } from "./run-prompt.js";
import { readCronJobScratchState } from "./scratch-store.js";
import { captureCronCapacityLease } from "./service/run-admission-capacity.js";
import { resolveCronJobsStorePathFromConfig } from "./store.js";
import type {
  CronStoredJob,
  CronAgentExecutionStarted,
  CronResolvedDeliveryState,
} from "./types.js";

export async function runCronSessionTurn(params: {
  onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
  onLaneWait?: (info?: { waiting?: boolean }) => void;
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  job: CronStoredJob;
  text: string;
  abortSignal?: AbortSignal;
  assertCurrent: () => void;
  deliveryContext?: DeliveryContext;
}) {
  const { job } = params;
  const expectedTarget = captureSessionEventTarget(params.agentId, params.sessionKey);
  const delivery =
    job.payload.kind === "agentTurn" ? await resolveCronDeliveryContext(params) : undefined;
  params.assertCurrent();
  const requestedChat = delivery?.deliveryRequested && delivery.deliveryPlan.mode !== "webhook";
  const deliveryError =
    requestedChat && !delivery.resolvedDelivery.ok
      ? delivery.resolvedDelivery.error.message
      : undefined;
  // Resolution failure is a closed delivery decision. Never inherit the last
  // route (possibly a group) when an owner or explicit target failed to resolve.
  const route = delivery
    ? delivery.resolvedDelivery.ok
      ? delivery.resolvedDelivery
      : undefined
    : params.deliveryContext;
  let checkedDeliveryConfig: OpenClawConfig | undefined;
  const beforeDeliver = async () => {
    const cfg = getRuntimeConfig();
    if (delivery) {
      const current = await resolveCronDeliveryContext({ ...params, cfg });
      params.assertCurrent();
      if (
        !current.deliveryRequested ||
        !current.resolvedDelivery.ok ||
        !route ||
        current.resolvedDelivery.channel !== route.channel ||
        current.resolvedDelivery.to !== route.to ||
        current.resolvedDelivery.accountId !== route.accountId ||
        current.resolvedDelivery.threadId !== route.threadId
      ) {
        throw new Error(
          "Automation delivery policy or owner route changed while queued; inspect the run and retry with the current destination",
        );
      }
    }
    checkedDeliveryConfig = cfg;
  };
  const scratch = readCronJobScratchState(
    resolveCronJobsStorePathFromConfig(params.cfg),
    job.id,
  ).scratch;
  const externalSource =
    job.payload.kind === "agentTurn" ? job.payload.externalContentSource : undefined;
  const { applyLegacyHeartbeatPromptContribution } = await import("../infra/heartbeat-compat.js");
  let message = await applyLegacyHeartbeatPromptContribution({
    cfg: params.cfg,
    jobId: job.id,
    name: job.name,
    agentId: params.agentId,
    sessionKey: expectedTarget.sessionKey!,
    prompt: params.text,
    assertCurrent: params.assertCurrent,
  });
  if (
    externalSource &&
    job.payload.kind === "agentTurn" &&
    !job.payload.allowUnsafeExternalContent
  ) {
    const { buildSafeExternalPrompt } =
      await import("./isolated-agent/run-external-content.runtime.js");
    message = buildSafeExternalPrompt({
      content: message,
      source: externalSource === "gmail" ? "email" : "webhook",
      jobName: job.name,
      jobId: job.id,
      timestamp: new Date().toISOString(),
    });
    params.assertCurrent();
  }
  let text = appendCronUnattendedRunPreamble(message, { externalHook: Boolean(externalSource) });
  if (scratch) {
    text += `\n\nAutomation scratch (revision ${scratch.revision}):\n${sliceToolResultTextToBudget(scratch.content, 2000)}`;
  }
  const deferred = prepareAutomationSystemEvents(expectedTarget.sessionKey!, job.id);
  if (deferred.events.length) {
    text += `\n\nPending session notices:\n${sliceToolResultTextToBudget(deferred.events.map((event) => event.text).join("\n"), 2000)}`;
  }
  let sessionId: string | undefined;
  params.onLaneWait?.({ waiting: true });
  const receipt = enqueueSessionEvent(text, {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    source: "cron",
    contextKey: `cron:${job.id}`,
    expectedTarget,
    deliveryContext: route,
    abortSignal: params.abortSignal,
    scheduledAutomation: {
      job,
      assertCurrent: params.assertCurrent,
      capacity: captureCronCapacityLease(),
      beforeDeliver,
      sourceDelivery: delivery?.sourceDelivery,
      beforeStart: () => {
        const cfg = getRuntimeConfig();
        return (
          isCronWithinActiveHours(
            job.activeHours,
            Date.now(),
            cfg.agents?.defaults?.userTimezone,
          ) &&
          (!job.idleOnly ||
            isCronExecutionIdle(cfg, job, params.agentId, expectedTarget.sessionKey))
        );
      },
      onStarted: () => deferred.start(),
      onExecutionStarted: (info) => {
        sessionId = info.sessionId;
        params.onLaneWait?.({ waiting: false });
        params.onExecutionStarted?.({
          jobId: job.id,
          agentId: params.agentId,
          sessionId,
          sessionKey: info.sessionKey,
          phase: "runner_entered",
        });
      },
      assertDeliveryCurrent: () => {
        if (checkedDeliveryConfig !== getRuntimeConfig()) {
          throw new Error("Automation delivery policy changed before send");
        }
      },
    },
    deliver: delivery ? Boolean(requestedChat && !deliveryError) : true,
  });
  const result = await receipt.settled;
  const admissionDeferred = result.admissionDeferred;
  return {
    status: admissionDeferred
      ? ("skipped" as const)
      : result.status === "completed"
        ? ("ok" as const)
        : ("error" as const),
    admissionDeferred,
    error:
      result.error ??
      (result.status === "cancelled" ? "Automation session turn was cancelled" : undefined),
    summary: result.summary,
    sessionId,
    sessionKey: expectedTarget.sessionKey,
    executionStarted: result.executionStarted,
    delivered: result.deliveryAmbiguous ? undefined : result.delivered,
    deliveryState: result.deliveryAmbiguous
      ? ({
          status: "unknown",
          failureNotification: { status: "not-requested" },
        } satisfies CronResolvedDeliveryState)
      : undefined,
    deliveryError,
    deliveryAttempted: result.deliveryAttempted,
    deliverySuppressionReason: result.deliverySuppressionReason,
    ...(delivery
      ? {
          delivery: buildCronDeliveryTrace({
            deliveryPlan: delivery.deliveryPlan,
            resolvedDelivery: delivery.resolvedDelivery,
            sourceDeliveryOutcome: result.sourceDeliveryOutcome ?? {
              visibleDeliveries: [],
              verifiedMessageToolDelivery: false,
              satisfiesSourceDelivery: result.delivered && !result.deliveryAmbiguous,
              unverifiedMessageToolDelivery: false,
            },
            fallbackUsed: false,
            delivered: result.deliveryAmbiguous ? undefined : result.delivered,
          }),
        }
      : {}),
    ...(result.nextCheckMs !== undefined ? { nextCheck: { delayMs: result.nextCheckMs } } : {}),
  };
}
