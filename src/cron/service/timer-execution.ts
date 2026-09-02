import type { NormalizeReplySkipReason } from "../../auto-reply/reply/normalize-reply-skip-reason.js";
import { isCronWithinActiveHours } from "../active-hours.js";
import { type CronActiveJobMarker, isCronActiveJobMarkerCurrent } from "../active-jobs.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import { isProactiveJobCutoverPending } from "../proactive-job-receipt.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { resolveCronToolsAllowExecTargetRecoveryError } from "../scheduled-tool-policy.js";
import { isCronScratchEffectivelyEmpty } from "../scratch-contract.js";
import { readCronJobScratchState } from "../scratch-store.js";
import { cronScriptFailureMetadata } from "../script-failure.js";
import { appendCronPayloadText, cronStreamScheduleKey } from "../stream-schedule.js";
import type {
  CronDeliveryTrace,
  CronResolvedDeliveryState,
  CronJob,
  CronStoredJob,
  CronNextCheckProposal,
  CronRunOutcome,
  CronRunTelemetry,
} from "../types.js";
import { abortErrorMessage } from "./execution-errors.js";
import { resolveJobPayloadTextForMain } from "./jobs-scheduling.js";
import type { CronServiceState } from "./state.js";
import {
  type CronTriggerEvalOutcome,
  type ExecuteJobCoreOptions,
  resolveMainSessionCronDeliveryContext,
} from "./timer-execution-timeout.js";
import { enqueueCronSystemEvent, wake } from "./wake.js";

/** Executes a cron job without mutating persisted job state. */
export async function executeJobCore(
  state: CronServiceState,
  job: CronStoredJob,
  abortSignal?: AbortSignal,
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      deliverySuppressionReason?: NormalizeReplySkipReason;
      deliveryState?: CronResolvedDeliveryState;
      delivery?: CronDeliveryTrace;
      nextCheck?: CronNextCheckProposal;
      scriptStateChanged?: boolean;
      scriptState?: unknown;
      triggerEval?: CronTriggerEvalOutcome;
    }
> {
  options?.assertRunCurrent?.();
  const resolveAbortError = () => ({
    status: "error" as const,
    error: abortErrorMessage(abortSignal),
  });

  if (isProactiveJobCutoverPending(state.deps.storePath, job)) {
    return {
      status: "error",
      error: "Automation migration is incomplete; run openclaw doctor --fix",
    };
  }
  if (abortSignal?.aborted) {
    return resolveAbortError();
  }
  if (
    !isCronWithinActiveHours(
      job.activeHours,
      state.deps.nowMs(),
      state.deps.resolveUserTimezone?.(),
    )
  ) {
    return {
      status: "skipped",
      summary: "Outside this automation's active hours",
      executionStarted: false,
      delivered: false,
      deliveryAttempted: false,
    };
  }
  if (
    job.payload.kind === "agentTurn" &&
    job.payload.skipIfScratchEmpty &&
    isCronScratchEffectivelyEmpty(
      readCronJobScratchState(state.deps.storePath, job.id).scratch?.content,
    )
  ) {
    return {
      status: "skipped",
      summary: "Automation scratch is explicitly empty",
      executionStarted: false,
      delivered: false,
      deliveryAttempted: false,
    };
  }
  const execTargetRecoveryError = resolveCronToolsAllowExecTargetRecoveryError({
    jobId: job.id,
    requirement: job.toolsAllowExecTargetRequirement,
    execTarget: job.toolsAllowExecTarget,
  });
  if (execTargetRecoveryError) {
    return {
      status: "error",
      error: execTargetRecoveryError,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", execTargetRecoveryError, {
        nowMs: state.deps.nowMs,
      }),
    };
  }
  if (options?.streamScheduleKey !== undefined || options?.streamSourceIdentity !== undefined) {
    // Defense in depth over the locked admission checks: stream-origin work must
    // carry both the source definition and logical identity, and both must still
    // match the execution snapshot.
    const currentKey =
      job.schedule.kind === "stream" ? cronStreamScheduleKey(job.schedule) : undefined;
    if (
      options.streamScheduleKey === undefined ||
      options.streamSourceIdentity === undefined ||
      currentKey !== options.streamScheduleKey ||
      job.state.streamSourceIdentity !== options.streamSourceIdentity
    ) {
      return { status: "skipped", error: "stream batch source no longer current" };
    }
  }
  let effectiveJob = job;
  let triggerEval: CronTriggerEvalOutcome | undefined;
  if (job.trigger) {
    const evaluator = state.deps.evaluateCronTrigger;
    if (!evaluator) {
      return {
        status: "error",
        error: "cron trigger evaluator is unavailable",
        ...cronScriptFailureMetadata("trigger", "runtime_unavailable"),
      };
    }
    const evaluation = await evaluator({
      job,
      script: job.trigger.script,
      state: job.state.triggerState,
      streamBatch: options?.streamBatch,
      abortSignal,
    });
    options?.assertRunCurrent?.();
    // Trigger scripts may settle after cancellation; never start payload work
    // or persist trigger results for a run that has already been aborted.
    if (abortSignal?.aborted) {
      return resolveAbortError();
    }
    if (evaluation.kind === "busy") {
      state.deps.log.debug({ jobId: job.id }, "cron: trigger evaluation skipped while busy");
      return {
        status: "ok",
        triggerEval: { fired: false, stateChanged: false, busy: true },
      };
    }
    if (evaluation.kind === "error") {
      return {
        status: "error",
        error: `cron trigger evaluation failed (${evaluation.code}): ${evaluation.error}`,
        ...cronScriptFailureMetadata("trigger", evaluation.code),
        triggerEval: { fired: false, stateChanged: false },
      };
    }
    const stateChanged = Object.hasOwn(evaluation, "state");
    triggerEval = {
      fired: evaluation.fire,
      stateChanged,
      ...(stateChanged ? { state: evaluation.state } : {}),
    };
    if (!evaluation.fire) {
      return { status: "ok", triggerEval };
    }
    if (evaluation.message !== undefined) {
      effectiveJob = { ...job, payload: appendCronPayloadText(job.payload, evaluation.message) };
    }
  }
  // A fired trigger already executed code. Later payload admission cannot make
  // that occurrence replayable as wholly unstarted work.
  if (effectiveJob.payload.kind === "script") {
    const result = await executeScriptCronJob(
      state,
      effectiveJob,
      abortSignal,
      options?.activeJobMarker,
      options?.streamBatch,
      options?.assertRunCurrent,
    );
    return triggerEval ? { ...result, admissionDeferred: false, triggerEval } : result;
  }
  if (options?.streamBatch !== undefined) {
    effectiveJob = {
      ...effectiveJob,
      payload: appendCronPayloadText(effectiveJob.payload, options.streamBatch),
    };
  }
  if (effectiveJob.payload.kind === "skillCollectionReview") {
    const result = state.deps.runSkillCollectionReview
      ? await state.deps.runSkillCollectionReview({
          agentId: resolveCronJobEffectiveAgentId(
            effectiveJob,
            state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
          ),
          ...(abortSignal ? { abortSignal } : {}),
        })
      : { status: "skipped" as const, summary: "skill collection review runner unavailable" };
    return triggerEval ? { ...result, admissionDeferred: false, triggerEval } : result;
  }

  if (effectiveJob.payload.kind === "heartbeat") {
    return {
      status: "error",
      error:
        "Retired heartbeat job: run openclaw doctor --fix to convert it to an ordinary automation",
    };
  }
  if (
    effectiveJob.sessionTarget === "main" ||
    (effectiveJob.sessionTarget.startsWith("session:") && effectiveJob.payload.kind === "agentTurn")
  ) {
    const result = await executeMainSessionCronJob(
      state,
      effectiveJob,
      abortSignal,
      options?.assertRunCurrent,
      options,
    );
    return triggerEval ? { ...result, admissionDeferred: false, triggerEval } : result;
  }

  const result = await executeDetachedCronJob(
    state,
    effectiveJob,
    abortSignal,
    resolveAbortError,
    options,
  );
  return triggerEval ? { ...result, admissionDeferred: false, triggerEval } : result;
}

async function executeMainSessionCronJob(
  state: CronServiceState,
  job: CronStoredJob,
  abortSignal: AbortSignal | undefined,
  assertCurrent?: () => void,
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
    nextCheck?: CronNextCheckProposal;
  }
> {
  const text =
    job.payload.kind === "agentTurn" ? job.payload.message : resolveJobPayloadTextForMain(job);
  if (!text) {
    return { status: "skipped", error: "main job requires non-empty systemEvent text" };
  }
  if (!state.deps.runSessionEvent) {
    return {
      status: "error",
      error: "Session event execution is unavailable; restart the Gateway and retry",
    };
  }
  return await state.deps.runSessionEvent({
    onExecutionStarted: options?.onExecutionStarted,
    onLaneWait: options?.onLaneWait,
    job,
    text,
    abortSignal,
    assertCurrent: () => {
      abortSignal?.throwIfAborted();
      assertCurrent?.();
    },
    deliveryContext: resolveMainSessionCronDeliveryContext(state, job),
  });
}

async function executeDetachedCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  resolveAbortError: () => { status: "error"; error: string },
  options?: ExecuteJobCoreOptions,
): Promise<
  CronRunOutcome &
    CronRunTelemetry & {
      delivered?: boolean;
      deliveryAttempted?: boolean;
      deliveryError?: string;
      deliverySuppressionReason?: NormalizeReplySkipReason;
      deliveryState?: CronResolvedDeliveryState;
      delivery?: CronDeliveryTrace;
      nextCheck?: CronNextCheckProposal;
    }
> {
  if (job.payload.kind === "command") {
    if (!state.deps.runCommandJob) {
      const error = "cron command runner is not configured";
      return {
        status: "skipped",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
          severity: "warn",
          nowMs: state.deps.nowMs,
        }),
      };
    }
    const res = await state.deps.runCommandJob({
      job,
      abortSignal,
    });
    if (abortSignal?.aborted) {
      const error = abortErrorMessage(abortSignal);
      return {
        status: "error",
        error,
        diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
          nowMs: state.deps.nowMs,
        }),
      };
    }
    return {
      status: res.status,
      error: res.error,
      errorClassification: res.errorClassification,
      deliveryError: res.deliveryError,
      deliverySuppressionReason: res.deliverySuppressionReason,
      deliveryState: res.deliveryState,
      summary: res.summary,
      delivered: res.delivered,
      deliveryAttempted: res.deliveryAttempted,
      delivery: res.delivery,
      diagnostics: res.diagnostics,
      failureNotificationDetail: res.failureNotificationDetail,
    };
  }

  if (job.payload.kind !== "agentTurn") {
    const error = 'isolated job requires payload.kind="agentTurn" or "command"';
    return {
      status: "skipped",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-preflight", error, {
        severity: "warn",
        nowMs: state.deps.nowMs,
      }),
    };
  }
  if (abortSignal?.aborted) {
    const aborted = resolveAbortError();
    return {
      ...aborted,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", aborted.error, {
        nowMs: state.deps.nowMs,
      }),
    };
  }

  const res = await state.deps.runIsolatedAgentJob({
    assertCurrent: options?.assertRunCurrent,
    job,
    message: job.payload.message,
    abortSignal,
    onExecutionStarted: options?.onExecutionStarted,
    onExecutionPhase: options?.onExecutionPhase,
    onLaneWait: options?.onLaneWait,
    executionIdentity: options?.executionIdentity,
  });

  if (abortSignal?.aborted) {
    const error = abortErrorMessage(abortSignal);
    return {
      status: "error",
      error,
      diagnostics: createCronRunDiagnosticsFromError("cron-setup", error, {
        nowMs: state.deps.nowMs,
      }),
    };
  }

  return {
    status: res.status,
    error: res.error,
    errorClassification: res.errorClassification,
    executionStarted: res.executionStarted,
    admissionDeferred: res.admissionDeferred,
    // Forward the post-run delivery failure recorded on an otherwise
    // successful run so the service can persist it as `lastDeliveryError` and
    // emit it on the finished event for CLI/UI/API run logs (#95419).
    deliveryError: res.deliveryError,
    deliverySuppressionReason: res.deliverySuppressionReason,
    deliveryState: res.deliveryState,
    nextCheck: res.nextCheck,
    summary: res.summary,
    delivered: res.delivered,
    deliveryAttempted: res.deliveryAttempted,
    delivery: res.delivery,
    sessionId: res.sessionId,
    sessionKey: res.sessionKey,
    diagnostics: res.diagnostics,
    failureNotificationDetail: res.failureNotificationDetail,
    model: res.model,
    provider: res.provider,
    usage: res.usage,
  };
}

async function executeScriptCronJob(
  state: CronServiceState,
  job: CronJob,
  abortSignal: AbortSignal | undefined,
  activeJobMarker?: CronActiveJobMarker,
  streamBatch?: string,
  assertRunCurrent?: () => void,
) {
  if (state.deps.cronConfig?.triggers?.enabled === false) {
    return {
      status: "error" as const,
      error:
        "cron script payload execution is disabled because the operator set cron.triggers.enabled: false; remove it or set it to true to allow unattended scripts",
    };
  }
  if (!state.deps.runScriptJob) {
    return {
      status: "error" as const,
      error: "cron script payload executor is unavailable",
      ...cronScriptFailureMetadata("payload", "runtime_unavailable"),
    };
  }
  const expectedTarget = state.deps.captureSessionEventTarget?.(job);
  const result = await state.deps.runScriptJob({ job, streamBatch, abortSignal });
  // Script runners may settle after ignoring an abort. Recheck both operator
  // cancellation and scheduler ownership before any notify/wake side effect.
  if (!isCronActiveJobMarkerCurrent(activeJobMarker)) {
    return { status: "error" as const, error: "Gateway restarting." };
  }
  if (abortSignal?.aborted) {
    return { status: "error" as const, error: abortErrorMessage(abortSignal) };
  }
  assertRunCurrent?.();
  if (result.status !== "ok") {
    return result;
  }
  if (result.nextCheck && !job.pacing) {
    return {
      status: "error" as const,
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
      ...cronScriptFailureMetadata("payload", "invalid_input"),
    };
  }

  const notify = result.notify?.trim() ? result.notify : undefined;
  if ((job.sessionTarget === "main" && notify) || result.wake) {
    const agentId = resolveCronJobEffectiveAgentId(
      job,
      state.deps.resolveDefaultAgentId?.() ?? state.deps.defaultAgentId,
    );
    const deliveryContext =
      job.sessionTarget === "main" ? resolveMainSessionCronDeliveryContext(state, job) : undefined;
    const eventOptions = { agentId, ...(deliveryContext ? { deliveryContext } : {}) };
    if (job.sessionTarget === "main" && notify && !result.wake) {
      enqueueCronSystemEvent(state, notify, {
        ...eventOptions,
        contextKey: `cron:${job.id}:script`,
      });
    }
    if (result.wake) {
      if (!expectedTarget) {
        return {
          status: "error" as const,
          error:
            "Script follow-up has no original session target; inspect its result and request a fresh follow-up",
        };
      }
      const wakeResult = wake(state, {
        mode: result.wake,
        text: notify ?? `script job ${job.name} completed`,
        agentId,
        sessionKey: job.sessionKey,
        expectedTarget,
      });
      if (!wakeResult.ok) {
        return { status: "error" as const, error: wakeResult.reason ?? "Wake was refused" };
      }
    }
  }
  return {
    status: "ok" as const,
    ...(notify ? { summary: notify } : {}),
    delivered: result.delivered,
    deliveryAttempted: result.deliveryAttempted,
    deliveryError: result.deliveryError,
    deliverySuppressionReason: result.deliverySuppressionReason,
    deliveryState: result.deliveryState,
    delivery: result.delivery,
    nextCheck: result.nextCheck,
    scriptStateChanged: result.stateChanged === true,
    ...(result.stateChanged === true ? { scriptState: result.state } : {}),
  };
}

/** Clears the currently armed cron timer. */
export function stopTimer(state: CronServiceState) {
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.timer = null;
}
