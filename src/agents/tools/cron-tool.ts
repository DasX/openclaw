/**
 * cron built-in tool.
 *
 * Manages scheduled jobs, wake/run actions, delivery context, and reminder-style payload normalization.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveCronCreationDelivery } from "../../cron/delivery-context.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  createAutomationResultRecorder,
  createAutomationRunGuard,
  getAgentRunContext,
  recordCronNextCheckProposal,
} from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { isRecord } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { CRON_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { AUTOMATIONS_TOOL_NAME } from "./automations-tool-name.js";
import {
  type AnyAgentTool,
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";
import {
  assertCronToolAgentFieldMatchesScope,
  assertCronToolSessionRefsMatchScope,
  readCronToolAgentId,
  resolveCronToolCallerScope,
} from "./cron-tool-caller-scope.js";
import {
  canonicalizeCronToolObject,
  hasCronCreateSignal,
  isEmptyRecoveredCronPatch,
  recoverCronObjectFromFlatParams,
  stripCronCreateNullClears,
} from "./cron-tool-canonicalize.js";
import {
  buildReminderContextLines,
  REMINDER_CONTEXT_MARKER,
  stripExistingContext,
} from "./cron-tool-context.js";
import {
  assertInheritedCronToolCaptureReady,
  capCronJobToolsAllowOnCreate,
  cronCreateRequiresCreatorAuthority,
  resolveCronCreatorExecToolTarget,
} from "./cron-tool-creator-cap.js";
import {
  buildCronToolDescription,
  formatCronTerminalPresentation,
} from "./cron-tool-presentation.js";
import {
  assertCronPacingInput,
  createCronToolSchema,
  CRON_TOOL_LIST_MAX_LIMIT,
} from "./cron-tool-schema.js";
import { listCronSelfJob } from "./cron-tool-self-list.js";
import {
  assertCronCreatorAuthorityResolutionAvailable,
  assertNoCronShellExecution,
  updateCronJobFromAgentTool,
} from "./cron-tool-write.js";
import type { CronToolDeps, CronToolOptions } from "./cron-tool.types.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callGatewayTool, readGatewayCallOptions, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

export type { CronCreatorToolAllowlistEntry, CronToolsAllowCaptureRef } from "./cron-tool.types.js";
export {
  captureFinalEffectiveCronCreatorToolAllowlist,
  replaceWithEffectiveCronCreatorToolAllowlist,
} from "./cron-tool-creator-cap.js";

function isMissingOrEmptyObject(value: unknown): boolean {
  return !value || (isRecord(value) && Object.keys(value).length === 0);
}

function readCronJobIdParam(params: Record<string, unknown>) {
  return readToolStringParam(params, "jobId") ?? readToolStringParam(params, "id");
}

const CRON_SELF_REMOVE_SCOPE_ERROR = "Automations tool is restricted to the current automation.";

function readCronSelfRemoveOnlyJobId(opts: CronToolOptions | undefined) {
  return opts?.selfRemoveOnlyJobId?.trim() || undefined;
}

function isCronSelfIntrospectionAction(action: string) {
  return action === "status" || action === "list";
}

function assertCronSelfRemoveScope(
  opts: CronToolOptions | undefined,
  action: string,
  params: Record<string, unknown>,
) {
  const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
  if (!selfRemoveOnlyJobId || isCronSelfIntrospectionAction(action)) {
    return;
  }
  if (
    action === "next_check" ||
    action === "scratch_get" ||
    action === "scratch_set" ||
    action === "record_result"
  ) {
    const id = readCronJobIdParam(params);
    if (!id || id === selfRemoveOnlyJobId) {
      return;
    }
  }
  if (action === "get" || action === "remove" || action === "runs") {
    const id = readCronJobIdParam(params);
    if (id && id === selfRemoveOnlyJobId) {
      return;
    }
  }
  throw new Error(CRON_SELF_REMOVE_SCOPE_ERROR);
}

function filterCronStatusResultForSelfScope(result: unknown): unknown {
  return { enabled: isRecord(result) && result.enabled === true };
}

function isOlderGatewayWithoutCompactCronList(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("invalid cron.list params") &&
    error.message.includes("unexpected property 'compact'")
  );
}

export function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool {
  const callGateway = deps?.callGatewayTool ?? callGatewayTool;
  const assertCurrentRun =
    opts?.runId && opts.selfRemoveOnlyJobId
      ? createAutomationRunGuard(opts.runId, opts.selfRemoveOnlyJobId)
      : undefined;
  const automationRun =
    opts?.runId && opts.selfRemoveOnlyJobId
      ? getAgentRunContext(opts.runId)?.cronRunsByJobId?.get(opts.selfRemoveOnlyJobId)
      : undefined;
  const activeRun = Boolean(automationRun?.assertCurrent && !automationRun.closed);
  const pacingEnabled = Boolean(activeRun && automationRun?.pacingEnabled);

  const recordResult =
    opts?.runId && opts.selfRemoveOnlyJobId
      ? createAutomationResultRecorder(opts.runId, opts.selfRemoveOnlyJobId)
      : undefined;
  // Trigger-gated surfaces default on, matching cron/service/jobs-validation.ts.
  const triggersEnabled = opts?.config?.cron?.triggers?.enabled !== false;
  const tool: AnyAgentTool = {
    label: "Automations",
    name: AUTOMATIONS_TOOL_NAME,
    displaySummary: CRON_TOOL_DISPLAY_SUMMARY,
    description: buildCronToolDescription({
      triggersEnabled,
      selfScoped: Boolean(opts?.selfRemoveOnlyJobId),
      pacingEnabled,
      activeRun,
    }),
    parameters: createCronToolSchema({
      agentSessionKey: opts?.agentSessionKey,
      triggersEnabled,
      selfScoped: Boolean(opts?.selfRemoveOnlyJobId),
      pacingEnabled,
      activeRun,
    }),
    execute: async (_toolCallId, args, operationSignal) => {
      operationSignal?.throwIfAborted();
      assertCurrentRun?.();
      const params = args as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      assertCronSelfRemoveScope(opts, action, params);
      const parsedGatewayOpts = readGatewayCallOptions(params);
      const gatewayOpts: GatewayCallOptions = {
        ...parsedGatewayOpts,
        timeoutMs: parsedGatewayOpts.timeoutMs ?? 60_000,
      };
      const runtimeConfig = getRuntimeConfig();
      const callerScope = resolveCronToolCallerScope(opts, runtimeConfig);
      const creatorExecToolTarget = resolveCronCreatorExecToolTarget(opts?.creatorToolAllowlist);
      const callerIdentity =
        callerScope && opts?.agentSessionKey?.trim()
          ? {
              agentId: callerScope.agentId,
              sessionKey: opts.agentSessionKey.trim(),
              turnSourceAccountId: opts.agentAccountId,
              ...(readCronSelfRemoveOnlyJobId(opts)
                ? { cronSelfManagementJobId: readCronSelfRemoveOnlyJobId(opts) }
                : {}),
              ...(opts?.creatorToolAllowlistCaptureRef?.value?.version === 1 &&
              opts.creatorToolAllowlistCaptureRef.value.source === "final-executable-surface"
                ? {
                    cronToolsAllowCapture: "final-executable-surface" as const,
                    ...(creatorExecToolTarget ? { cronExecToolTarget: creatorExecToolTarget } : {}),
                  }
                : {}),
            }
          : undefined;

      return await withGatewayToolCallerIdentity(callerIdentity, async () => {
        switch (action) {
          case "status": {
            const result = await callGateway("cron.status", gatewayOpts, {});
            return jsonResult(
              readCronSelfRemoveOnlyJobId(opts)
                ? filterCronStatusResultForSelfScope(result)
                : result,
            );
          }
          case "list": {
            const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
            const explicitAgentId = readCronToolAgentId(params.agentId);
            if (callerScope && explicitAgentId && explicitAgentId !== callerScope.agentId) {
              throw new Error("cron list agentId must match the calling agent");
            }
            const listAgentId = callerScope?.agentId ?? explicitAgentId;
            const includeDisabled = Boolean(params.includeDisabled);
            const requestedLimit = selfRemoveOnlyJobId
              ? undefined
              : readPositiveIntegerParam(params, "limit", {
                  max: CRON_TOOL_LIST_MAX_LIMIT,
                  message: `limit must be a positive integer no greater than ${CRON_TOOL_LIST_MAX_LIMIT}`,
                });
            const requestedOffset = selfRemoveOnlyJobId
              ? undefined
              : readNonNegativeIntegerParam(params, "offset");
            let useCompactList = true;
            const requestListPage = async (pageParams: Record<string, unknown>) => {
              for (;;) {
                try {
                  return await callGateway("cron.list", gatewayOpts, {
                    includeDisabled,
                    ...(useCompactList ? { compact: true } : {}),
                    ...(listAgentId ? { agentId: listAgentId } : {}),
                    ...pageParams,
                  });
                } catch (error) {
                  if (!useCompactList || !isOlderGatewayWithoutCompactCronList(error)) {
                    throw error;
                  }
                  // Protocol v4 gateways predating compact reject the additive field.
                  // Retry without it for mixed-version correctness; remove at the next protocol break.
                  useCompactList = false;
                }
              }
            };
            if (!selfRemoveOnlyJobId) {
              const result = await requestListPage({
                ...(requestedLimit !== undefined ? { limit: requestedLimit } : {}),
                ...(requestedOffset !== undefined ? { offset: requestedOffset } : {}),
              });
              return jsonResult(result);
            }

            return jsonResult(
              await listCronSelfJob({
                jobId: selfRemoveOnlyJobId,
                pageSize: CRON_TOOL_LIST_MAX_LIMIT,
                requestPage: requestListPage,
              }),
            );
          }
          case "get": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            return jsonResult(
              await callGateway("cron.get", gatewayOpts, {
                id,
              }),
            );
          }
          case "add": {
            // Flat-params recovery: non-frontier models (e.g. Grok) sometimes flatten
            // job properties to the top level alongside `action` instead of nesting
            // them inside `job`. When `params.job` is missing or empty, reconstruct
            // a synthetic job object from any recognised top-level job fields.
            // See: https://github.com/openclaw/openclaw/issues/11310
            if (isMissingOrEmptyObject(params.job)) {
              const synthetic = recoverCronObjectFromFlatParams(params);
              // Only use the synthetic job if at least one meaningful field is present
              // (schedule, payload, message, or text are the minimum signals that the
              // LLM intended to create a job).
              if (synthetic.found && hasCronCreateSignal(synthetic.value)) {
                params.job = synthetic.value;
              }
            }

            if (!params.job || typeof params.job !== "object") {
              throw new Error("job required");
            }
            const canonicalJob = stripCronCreateNullClears(
              canonicalizeCronToolObject(params.job as Record<string, unknown>),
            );
            assertNoCronShellExecution(canonicalJob);
            assertCronDeliveryInputNonBlankFields(canonicalJob.delivery);
            assertCronPacingInput(canonicalJob.pacing);
            if (
              typeof canonicalJob.declarationKey === "string" &&
              canonicalJob.declarationKey.trim().length === 0
            ) {
              throw new Error("declarationKey must be a non-empty string");
            }
            if (
              typeof canonicalJob.displayName === "string" &&
              canonicalJob.displayName.trim().length === 0
            ) {
              throw new Error("displayName must be a non-empty string");
            }
            const enabledExplicit = typeof canonicalJob.enabled === "boolean";
            const job =
              normalizeCronJobCreate(canonicalJob, {
                sessionContext: { sessionKey: opts?.agentSessionKey },
              }) ?? canonicalJob;
            if (
              typeof job.declarationKey === "string" &&
              job.declarationKey.length > 0 &&
              !enabledExplicit
            ) {
              delete job.enabled;
            }
            const requiresCreatorAuthority = cronCreateRequiresCreatorAuthority(
              job,
              opts?.creatorToolAllowlist,
            );
            assertCronCreatorAuthorityResolutionAvailable({
              required: requiresCreatorAuthority,
              resolveCreatorToolAuthority: opts?.resolveCreatorToolAuthority,
              creatorToolAllowlistCaptureRef: opts?.creatorToolAllowlistCaptureRef,
              unavailableReason: opts?.creatorAuthorityUnavailableReason,
            });
            const resolvedAuthority =
              requiresCreatorAuthority && opts?.resolveCreatorToolAuthority
                ? await opts.resolveCreatorToolAuthority({ signal: operationSignal })
                : undefined;
            operationSignal?.throwIfAborted();
            const creatorToolAllowlist = resolvedAuthority?.tools ?? opts?.creatorToolAllowlist;
            const creatorToolAllowlistCaptureRef = resolvedAuthority
              ? { value: resolvedAuthority.provenance }
              : opts?.creatorToolAllowlistCaptureRef;
            capCronJobToolsAllowOnCreate(job, creatorToolAllowlist);
            assertInheritedCronToolCaptureReady(job, creatorToolAllowlistCaptureRef);
            if (job && typeof job === "object") {
              const { mainKey, alias } = resolveMainSessionAlias(runtimeConfig);
              const resolvedSessionKey = opts?.agentSessionKey
                ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
                : undefined;
              if (callerScope) {
                assertCronToolAgentFieldMatchesScope({
                  value: (job as { agentId?: unknown }).agentId,
                  field: "automation agentId",
                  callerScope,
                });
                (job as { agentId?: string }).agentId = callerScope.agentId;
                assertCronToolSessionRefsMatchScope(job as Record<string, unknown>, callerScope);
              }
              const sessionTarget = normalizeLowercaseStringOrEmpty(
                (job as { sessionTarget?: unknown }).sessionTarget,
              );
              if (!("sessionKey" in job) && resolvedSessionKey && sessionTarget !== "isolated") {
                (job as { sessionKey?: string }).sessionKey = resolvedSessionKey;
              }
            }

            if (
              (opts?.agentSessionKey || opts?.currentDeliveryContext) &&
              job &&
              typeof job === "object" &&
              "payload" in job &&
              (job as { payload?: { kind?: string } }).payload?.kind === "agentTurn"
            ) {
              const deliveryValue = (job as { delivery?: unknown }).delivery;
              const delivery = isRecord(deliveryValue) ? deliveryValue : undefined;
              const modeRaw = typeof delivery?.mode === "string" ? delivery.mode : "";
              const mode = normalizeLowercaseStringOrEmpty(modeRaw);
              if (mode === "webhook") {
                const webhookUrl = normalizeHttpWebhookUrl(delivery?.to);
                if (!webhookUrl) {
                  throw new Error(
                    'delivery.mode="webhook" requires delivery.to to be a valid http(s) URL',
                  );
                }
                if (delivery) {
                  delivery.to = webhookUrl;
                }
              }

              const hasTarget =
                (typeof delivery?.channel === "string" && delivery.channel.trim()) ||
                (typeof delivery?.to === "string" && delivery.to.trim());
              const shouldInfer =
                (deliveryValue == null || delivery) &&
                (mode === "" || mode === "announce") &&
                !hasTarget &&
                delivery?.target !== "owner";
              if (shouldInfer) {
                const inferred = resolveCronCreationDelivery({
                  cfg: runtimeConfig,
                  currentDeliveryContext: opts.currentDeliveryContext,
                  agentSessionKey: opts.agentSessionKey,
                });
                if (inferred) {
                  (job as { delivery?: unknown }).delivery = {
                    ...inferred,
                    ...delivery,
                  } satisfies CronDelivery;
                }
              }
            }

            const contextMessages = readNonNegativeIntegerParam(params, "contextMessages") ?? 0;
            if (
              job &&
              typeof job === "object" &&
              "payload" in job &&
              (job as { payload?: { kind?: string; text?: string } }).payload?.kind ===
                "systemEvent"
            ) {
              const payload = (job as { payload: { kind: string; text: string } }).payload;
              if (typeof payload.text === "string" && payload.text.trim()) {
                const contextLines = await buildReminderContextLines({
                  agentSessionKey: opts?.agentSessionKey,
                  agentId: callerScope?.agentId,
                  gatewayOpts,
                  contextMessages,
                  callGatewayTool: callGateway,
                });
                if (contextLines.length > 0) {
                  const baseText = stripExistingContext(payload.text);
                  payload.text = `${baseText}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
                }
              }
            }
            const resolvedExecToolTarget = resolveCronCreatorExecToolTarget(
              resolvedAuthority?.tools,
            );
            const writeCallerIdentity =
              resolvedAuthority && callerIdentity
                ? {
                    ...callerIdentity,
                    cronToolsAllowCapture: "final-executable-surface" as const,
                    ...(resolvedExecToolTarget
                      ? { cronExecToolTarget: resolvedExecToolTarget }
                      : {}),
                    cronCreatorAuthorityGrant: resolvedAuthority.grant,
                  }
                : callerIdentity;
            if (
              resolvedAuthority &&
              (!writeCallerIdentity || !("cronCreatorAuthorityGrant" in writeCallerIdentity))
            ) {
              throw new Error(
                "fresh configured MCP cron authority requires an authenticated local agent run",
              );
            }
            return jsonResult(
              await withGatewayToolCallerIdentity(
                writeCallerIdentity,
                async () =>
                  await callGateway("cron.add", gatewayOpts, {
                    ...job,
                  }),
              ),
            );
          }
          case "update": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }

            // Flat-params recovery for update patches
            let recoveredFlatPatch = false;
            if (isMissingOrEmptyObject(params.job)) {
              const synthetic = recoverCronObjectFromFlatParams(params);
              if (synthetic.found) {
                params.job = synthetic.value;
                recoveredFlatPatch = true;
              }
            }

            if (!params.job || typeof params.job !== "object") {
              throw new Error("job required");
            }
            const canonicalPatch = canonicalizeCronToolObject(
              params.job as Record<string, unknown>,
            );
            assertNoCronShellExecution(canonicalPatch);
            assertCronDeliveryInputNonBlankFields(canonicalPatch.delivery);
            assertCronPacingInput(canonicalPatch.pacing);
            if (
              typeof canonicalPatch.displayName === "string" &&
              canonicalPatch.displayName.trim().length === 0
            ) {
              throw new Error("displayName must be a non-empty string or null");
            }
            const patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
            if (recoveredFlatPatch && isEmptyRecoveredCronPatch(patch)) {
              throw new Error("job required");
            }
            if (callerScope && "agentId" in patch) {
              throw new Error("automation patch agentId cannot be changed by the automations tool");
            }
            if (callerScope) {
              assertCronToolSessionRefsMatchScope(patch, callerScope);
            }
            return jsonResult(
              await updateCronJobFromAgentTool({
                id,
                patch,
                creatorToolAllowlist: opts?.creatorToolAllowlist,
                creatorToolAllowlistCaptureRef: opts?.creatorToolAllowlistCaptureRef,
                resolveCreatorToolAuthority: opts?.resolveCreatorToolAuthority,
                withCreatorAuthorityProvenance: callerIdentity
                  ? async (authority, run) => {
                      const authorityExecToolTarget = resolveCronCreatorExecToolTarget(
                        authority.tools,
                      );
                      return await withGatewayToolCallerIdentity(
                        {
                          ...callerIdentity,
                          cronToolsAllowCapture: "final-executable-surface",
                          ...(authorityExecToolTarget
                            ? { cronExecToolTarget: authorityExecToolTarget }
                            : {}),
                          cronCreatorAuthorityGrant: authority.grant,
                        },
                        run,
                      );
                    }
                  : undefined,
                gatewayOpts,
                callGateway,
                operationSignal,
                creatorAuthorityUnavailableReason: opts?.creatorAuthorityUnavailableReason,
              }),
            );
          }
          case "remove": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            return jsonResult(
              await callGateway("cron.remove", gatewayOpts, {
                id,
              }),
            );
          }
          case "run": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            const runMode =
              params.runMode === "due" || params.runMode === "force" ? params.runMode : "due";
            return jsonResult(
              await callGateway("cron.run", gatewayOpts, {
                id,
                mode: runMode,
              }),
            );
          }
          case "runs": {
            const id = readCronJobIdParam(params);
            if (!id) {
              throw new Error("jobId required (id accepted for backward compatibility)");
            }
            return jsonResult(
              await callGateway("cron.runs", gatewayOpts, {
                id,
              }),
            );
          }
          case "scratch_get":
          case "scratch_set": {
            const jobId = readCronSelfRemoveOnlyJobId(opts);
            if (!jobId || !assertCurrentRun) {
              throw new Error(
                "scratch actions are only available inside the currently running automation; use the automation editor for other jobs",
              );
            }
            if (action === "scratch_get") {
              return jsonResult(await callGateway("cron.scratch.get", gatewayOpts, { id: jobId }));
            }
            if (typeof params.content !== "string" && params.content !== null) {
              throw new Error("scratch_set requires complete content or null to clear");
            }
            const expectedRevision = readNonNegativeIntegerParam(params, "expectedRevision");
            if (expectedRevision === undefined) {
              throw new Error("scratch_set requires expectedRevision from scratch_get");
            }
            return jsonResult(
              await callGateway("cron.scratch.set", gatewayOpts, {
                id: jobId,
                content: params.content,
                expectedRevision,
              }),
            );
          }
          case "record_result": {
            const jobId = readCronSelfRemoveOnlyJobId(opts);
            const runId = opts?.runId?.trim();
            if (!jobId || !runId || !recordResult) {
              throw new Error(
                "record_result is only available inside the currently running automation",
              );
            }
            const outcome = params.outcome;
            if (
              outcome !== "no_change" &&
              outcome !== "progress" &&
              outcome !== "done" &&
              outcome !== "blocked" &&
              outcome !== "needs_attention"
            ) {
              throw new Error(
                "record_result requires no_change, progress, done, blocked, or needs_attention",
              );
            }
            const summary = readToolStringParam(params, "summary", { required: true });
            recordResult({ outcome, summary });
            return jsonResult({ ok: true, outcome, summary });
          }
          case "next_check": {
            const jobId = readCronSelfRemoveOnlyJobId(opts);
            const runId = opts?.runId?.trim();
            if (!jobId || !runId) {
              throw new Error("cron next_check is only available to the currently running job");
            }
            const rawDuration = readToolStringParam(params, "in", { required: true });
            let delayMs: number;
            try {
              delayMs = parseDurationMs(rawDuration);
            } catch {
              throw new Error("cron next_check in must be a positive duration");
            }
            if (delayMs <= 0) {
              throw new Error("cron next_check in must be a positive duration");
            }
            recordCronNextCheckProposal(runId, jobId, delayMs);
            return jsonResult({ ok: true, delayMs });
          }
          case "wake": {
            const text = readToolStringParam(params, "text", { required: true });
            const mode =
              params.mode === "now" || params.mode === "next-heartbeat"
                ? params.mode
                : "next-heartbeat";
            // Resolve the calling agent's session key into the internal form
            // the cron service routes by (mirrors the `add` action above).
            // Without this, the wake gateway call goes through with no session
            // key and the system event lands on the heartbeat / main default
            // rather than the originating conversation lane. Closes the
            // upstream half of openclaw/openclaw#46886 (#64556 — agentId/
            // sessionKey silently ignored for `action: "wake"`). Explicit
            // params on the tool call still take precedence over the inferred
            // value, so call sites can wake a different session owned by the
            // calling agent.
            const cfg = getRuntimeConfig();
            const { mainKey, alias } = resolveMainSessionAlias(cfg);
            const explicitSessionKey = readToolStringParam(params, "sessionKey");
            const explicitAgentId = readToolStringParam(params, "agentId");
            if (callerScope) {
              assertCronToolAgentFieldMatchesScope({
                value: explicitAgentId,
                field: "wake agentId",
                callerScope,
              });
              assertCronToolSessionRefsMatchScope({ sessionKey: explicitSessionKey }, callerScope);
            }
            const inferredSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
              : undefined;
            const inferredAgentId = opts?.agentSessionKey
              ? resolveSessionAgentId({
                  sessionKey: opts.agentSessionKey,
                  config: cfg,
                  agentId: opts.agentId,
                })
              : undefined;
            const sessionKey = explicitSessionKey ?? inferredSessionKey;
            // When a caller supplies an explicit cross-agent sessionKey without
            // an explicit agentId, the gateway target resolver treats agentId as
            // authoritative — pairing the caller's inferred agentId with a
            // foreign session key would canonicalize the wake back to the
            // caller's main lane. Derive the agentId from the explicit canonical
            // session key instead; only fall through to the inferred
            // caller-agent when no explicit sessionKey was supplied.
            const agentIdFromExplicitSessionKey = explicitSessionKey
              ? parseAgentSessionKey(explicitSessionKey)?.agentId
              : undefined;
            // A contradictory explicit pair (agentId X + a sessionKey owned by
            // agent Y) is ambiguous: the gateway target resolver treats agentId
            // as authoritative and would silently canonicalize the wake onto a
            // session under X that the caller never named. Reject instead of
            // guessing one canonical owner.
            if (
              explicitAgentId &&
              agentIdFromExplicitSessionKey &&
              normalizeLowercaseStringOrEmpty(explicitAgentId) !==
                normalizeLowercaseStringOrEmpty(agentIdFromExplicitSessionKey)
            ) {
              throw new Error(
                `wake agentId "${explicitAgentId}" contradicts the agent that owns sessionKey ` +
                  `("${agentIdFromExplicitSessionKey}"); pass a single canonical wake target`,
              );
            }
            const agentId =
              callerScope?.agentId ??
              explicitAgentId ??
              (explicitSessionKey ? agentIdFromExplicitSessionKey : inferredAgentId);
            return jsonResult(
              await callGateway(
                "wake",
                gatewayOpts,
                {
                  mode,
                  text,
                  ...(sessionKey ? { sessionKey } : {}),
                  ...(agentId ? { agentId } : {}),
                },
                { expectFinal: false },
              ),
            );
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      });
    },
  };
  return setToolTerminalPresentation(tool, formatCronTerminalPresentation);
}
