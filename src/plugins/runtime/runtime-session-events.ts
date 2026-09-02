import {
  captureSessionEventTargetForHost as captureTarget,
  enqueueSessionEventForHost as enqueueSessionEventCore,
  type SessionEventTarget as HostTarget,
} from "../../auto-reply/reply/session-event-handoff.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

declare const capturedTarget: unique symbol;
type SessionEventTarget = { readonly [capturedTarget]: true };
// Runtime chunks share opaque handles; the host still validates their captured lifecycle on use.
const targets = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginSessionEventTargets"),
  () => new WeakMap<SessionEventTarget, HostTarget>(),
);

/** Capture the original destination before asynchronous plugin work. Copies are not capabilities. */
export function captureSessionEventTarget(agentId: string, sessionKey: string): SessionEventTarget {
  const target = captureTarget(agentId, sessionKey);
  const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertSystemOwnerCurrent;
  if (assertCurrent) {
    target.assertCurrent = assertCurrent;
  }
  // Redemption rejects copies and the host revalidates the captured lifecycle.
  // SAFETY: Only this mint registers the fresh handle's identity in the host-owned WeakMap.
  const handle = Object.freeze({}) as SessionEventTarget;
  targets.set(handle, target);
  return handle;
}

/** Schedule a bounded internal follow-up through the destination's normal session queue. */
export function enqueueSessionEvent(
  text: string,
  options: {
    agentId: string;
    sessionKey: string;
    contextKey?: string;
    deliveryContext?: DeliveryContext;
    abortSignal?: AbortSignal;
    expectedTarget?: SessionEventTarget;
  },
) {
  const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertSystemOwnerCurrent;
  const expectedTarget = options.expectedTarget ? targets.get(options.expectedTarget) : undefined;
  if (options.expectedTarget && !expectedTarget) {
    throw new Error(
      "Session event target was not captured by this runtime; capture it before starting asynchronous work",
    );
  }
  // Copy the public fields; plugin input must never inject scheduler or admission capabilities.
  return enqueueSessionEventCore(text, {
    agentId: options.agentId,
    sessionKey: options.sessionKey,
    source: "plugin",
    contextKey: options.contextKey,
    deliveryContext: options.deliveryContext,
    abortSignal: options.abortSignal,
    expectedTarget,
    ...(assertCurrent ? { assertCurrent } : {}),
  });
}
