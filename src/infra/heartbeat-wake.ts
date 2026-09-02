// Stable SDK adapter; execution belongs to ordinary job/session owners.
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  captureSessionEventTargetForHost as captureSessionEventTarget,
  assertSessionEventTargetCurrent,
} from "../auto-reply/reply/session-event-handoff.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";
export type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";

const log = createSubsystemLogger("heartbeat/compat");

/**
 * @deprecated Use session events or ordinary automations. Retained through at least
 * one stable replacement release; removal requires a separately approved breaking SDK release.
 */
export function requestHeartbeat(opts: HeartbeatWakeRequest): void {
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.resolveGatewayContext ? scope.resolveGatewayContext() : scope?.context;
  if (!context) {
    throw new Error(
      "Heartbeat compatibility calls require a live Gateway. Use enqueueSessionEvent with an explicit agent and session.",
    );
  }
  const assertCurrent = () => {
    scope?.assertSystemOwnerCurrent?.();
    if (scope?.resolveGatewayContext && scope.resolveGatewayContext() !== context) {
      throw new Error("Heartbeat caller's Gateway owner was retired or replaced");
    }
  };
  assertCurrent();
  if (opts.tasks?.length || opts.scheduledEveryMs !== undefined || opts.retainedWork) {
    throw new Error(
      "Heartbeat task scheduling is retired. Run openclaw doctor --fix and use ordinary automations.",
    );
  }
  // SDK intent selects eligibility, not the wire next-heartbeat deferral contract.
  if (opts.intent === "manual" || opts.intent === "scheduled") {
    void import("./heartbeat-runner.js")
      .then(async ({ runHeartbeatOnce }) => {
        assertCurrent();
        const result = await runHeartbeatOnce({ ...opts, dueOnly: opts.intent === "scheduled" });
        if (result.status !== "ran") {
          log.warn(`Heartbeat compatibility check ${result.status}: ${result.reason}`);
        }
      })
      .catch((error: unknown) => log.error(String(error)));
    return;
  }
  const cfg = context.getRuntimeConfig();
  const agentId =
    opts.agentId ?? parseAgentSessionKey(opts.sessionKey)?.agentId ?? resolveDefaultAgentId(cfg);
  const sessionKey = opts.sessionKey ?? resolveAgentMainSessionKey({ cfg, agentId });
  const expectedTarget = captureSessionEventTarget(agentId, sessionKey);
  expectedTarget.assertCurrent = assertCurrent;
  const target = opts.heartbeat?.target?.trim();
  if (target === "none") {
    expectedTarget.deliver = false;
  }
  const enqueue = () => {
    assertSessionEventTargetCurrent(expectedTarget);
    const result = context.cron.wake({
      mode: "now",
      text: opts.reason?.trim() || "Review pending session events.",
      agentId,
      sessionKey,
      expectedTarget,
    });
    if (!result.ok) {
      throw new Error(result.reason ?? "Heartbeat compatibility wake was refused");
    }
  };
  if (
    target === "none" ||
    ((!target || target === "last") && !opts.heartbeat?.to && !opts.heartbeat?.accountId)
  ) {
    enqueue();
    return;
  }
  void import("../cron/isolated-agent/delivery-target.js")
    .then(async ({ resolveDeliveryTarget }) => {
      assertCurrent();
      const route = await resolveDeliveryTarget(cfg, agentId, {
        sessionKey,
        target: target === "owner" ? "owner" : undefined,
        channel: target === "owner" || target === "none" ? undefined : target,
        to: opts.heartbeat?.to,
        accountId: opts.heartbeat?.accountId,
      });
      assertSessionEventTargetCurrent(expectedTarget);
      if (!route.ok) {
        throw route.error;
      }
      expectedTarget.deliveryContext = {
        channel: route.channel,
        to: route.to,
        accountId: route.accountId,
        threadId: route.threadId,
      };
      enqueue();
    })
    .catch((error: unknown) => log.error(String(error)));
}
