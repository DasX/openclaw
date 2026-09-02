import { resolveControlUiSessionUrl } from "../config/control-ui-link-base.js";
import { getRuntimeConfig } from "../infra/outbound/message.config.runtime.js";

// Runtime delivery seam for task terminal/state-change notifications.
export { sendMessage } from "../infra/outbound/message.js";

export function resolveTaskControlUiSessionUrl(params: {
  sessionKey: string;
  fallbackAgentId?: string;
}): string | undefined {
  return resolveControlUiSessionUrl(getRuntimeConfig(), { ...params, exactKey: true });
}

/** Drain through the same durable adoption/settlement owner used on Gateway restart. */
export async function deliverTaskSessionEvent(
  entry: import("../infra/session-delivery-queue-storage.js").QueuedSessionDelivery,
) {
  const [{ deliverQueuedSessionDelivery }, { createDefaultDeps }] = await Promise.all([
    import("../gateway/server-restart-sentinel.js"),
    import("../cli/deps.js"),
  ]);
  await deliverQueuedSessionDelivery({ deps: createDefaultDeps(), entry });
}
