/** Stable SDK boundary only. Execution belongs to ordinary cron jobs. */
import type { CronServiceRunOptions } from "../cron/service-contract.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getLegacyHeartbeatJobIds } from "./heartbeat-compat.js";
import type { HeartbeatRunResult, HeartbeatWakeOverride } from "./heartbeat-wake-contracts.js";

/** @deprecated Use ordinary automations; retained through the stable SDK migration window. */
export async function runHeartbeatOnce(opts?: {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  heartbeat?: HeartbeatWakeOverride;
  dueOnly?: boolean;
}): Promise<HeartbeatRunResult> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  if (!context) {
    return {
      status: "failed",
      reason: "A live Gateway is required; use an ordinary automation or enqueueSessionEvent.",
    };
  }
  const ids = new Set(getLegacyHeartbeatJobIds(context.getRuntimeConfig()));
  const jobs = (await context.cron.list({ includeDisabled: true })).filter(
    (job) =>
      ids.has(job.id) &&
      (!opts?.agentId || job.agentId === opts.agentId) &&
      (!opts?.sessionKey ||
        job.sessionKey === opts.sessionKey ||
        job.sessionTarget === `session:${opts.sessionKey}`),
  );
  if (jobs.length !== 1) {
    return {
      status: "failed",
      reason:
        "Select one converted/default proactive automation. Run openclaw doctor --fix if migration is pending.",
    };
  }
  const assertCurrent = () => {
    scope?.assertSystemOwnerCurrent?.();
    if (scope?.resolveGatewayContext && scope.resolveGatewayContext() !== context) {
      throw new Error("Heartbeat caller's Gateway owner was retired or replaced");
    }
  };
  assertCurrent();
  const selected = jobs[0]!;
  const target = opts?.heartbeat?.target?.trim();
  const delivery: CronServiceRunOptions["delivery"] =
    target || opts?.heartbeat?.to || opts?.heartbeat?.accountId
      ? {
          mode: target === "none" ? "none" : "announce",
          target: target === "owner" ? "owner" : undefined,
          channel: target === "none" || target === "owner" ? undefined : target,
          to: opts?.heartbeat?.to,
          threadId: undefined,
          ...(opts?.heartbeat?.accountId ? { accountId: opts.heartbeat.accountId } : {}),
        }
      : undefined;
  const started = Date.now();
  let outcome:
    | { status: "ok" | "error" | "skipped"; error?: string; deliveryError?: string }
    | undefined;
  const result = await context.cron.run(selected.id, opts?.dueOnly ? "due" : "if-enabled", {
    delivery,
    commitGuard: assertCurrent,
    onSettledResult: (settled) => {
      outcome = settled;
    },
  });
  if (!result.ok || !("ran" in result) || !result.ran) {
    return {
      status: "skipped",
      reason: "reason" in result ? result.reason : "Automation was not executed",
    };
  }
  if (!outcome) {
    return {
      status: "failed",
      reason: "Automation did not report a terminal result; inspect its run history.",
    };
  }
  if (outcome.status === "error" || outcome.deliveryError) {
    return {
      status: "failed",
      reason: outcome.deliveryError ?? outcome.error ?? "Automation failed",
    };
  }
  if (outcome.status === "skipped") {
    return {
      status: "skipped",
      reason: outcome.error ?? "Automation intentionally skipped execution",
    };
  }
  return { status: "ran", durationMs: Date.now() - started };
}
