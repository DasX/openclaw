import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import type { ChatType } from "../channels/chat-type.js";
import type { RestartSentinelContinuation } from "../infra/restart-sentinel.js";
import type {
  QueuedSessionDeliveryPayload,
  SessionDeliveryRoute,
} from "../infra/session-delivery-queue-storage.js";

export const RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS = 20;

export function resolveRestartContinuationRoute(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
}): SessionDeliveryRoute | undefined {
  if (!params.channel || !params.to) {
    return undefined;
  }
  return {
    channel: params.channel,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    chatType: params.chatType,
  };
}

export function buildQueuedRestartContinuation(params: {
  sessionKey: string;
  agentId?: string;
  continuation: RestartSentinelContinuation;
  route?: SessionDeliveryRoute;
  expectedSessionId?: string | undefined;
  expectedTarget?: SessionEventTarget;
  revision: number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  const idempotencyKey =
    params.idempotencyKey ??
    `restart-sentinel:${params.sessionKey}:${params.continuation.kind}:${params.revision}`;
  const expectedTarget = params.expectedTarget
    ? (() => {
        const { generation: _generation, ...target } = params.expectedTarget;
        return target;
      })()
    : undefined;
  const common = {
    sessionKey: params.sessionKey,
    ...(expectedTarget ? { expectedTarget } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey,
    maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
    completionRetention: "permanent" as const,
  };
  if (params.continuation.kind === "systemEvent") {
    return {
      ...common,
      kind: "systemEvent",
      ...(params.agentId ? { agentId: params.agentId } : {}),
      text: params.continuation.text,
    };
  }
  return {
    ...common,
    kind: "agentTurn",
    message: params.continuation.message,
    messageId: idempotencyKey,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    ...(params.route ? { route: params.route } : {}),
  };
}
