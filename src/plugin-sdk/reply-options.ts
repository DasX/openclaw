/** Public reply callbacks cannot carry private session or scheduler authority. */
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { REPLY_ADMISSION_TICKET } from "../auto-reply/reply/reply-admission-ticket.js";
import { REPLY_OPERATION_RUN_STATE } from "../auto-reply/reply/reply-operation-run-state.js";

export function publicReplyOptions(
  options: GetReplyOptions | undefined,
): GetReplyOptions | undefined {
  if (!options) {
    return undefined;
  }
  const publicOptions: InternalGetReplyOptions = { ...options };
  for (const key of [
    "scheduledAutomation",
    "modelOverride",
    "internalEventExecution",
    "replyOperation",
    "cronCreatorAuthorityCapability",
    "admittedSessionSettings",
    "expectedExistingSessionId",
    "newlyCreatedSessionId",
    "pinExpectedExistingSession",
    "requestedSessionId",
    "resumeRequestedSession",
    "queueModeOverride",
    "onQueuedFollowupReplyBatch",
    "skillWorkshopProposalRevision",
    "prepareAssistantTranscriptMessage",
    "onDeliberateSilentTerminalReply",
    "onPendingContinuation",
    "onSessionPrepared",
    "sessionPromptSourceReplyDeliveryMode",
    "onFollowupQueueDisposition",
    "skillOverrides",
    REPLY_ADMISSION_TICKET,
    REPLY_OPERATION_RUN_STATE,
  ] as const satisfies readonly (keyof InternalGetReplyOptions)[]) {
    delete publicOptions[key];
  }
  return publicOptions;
}

/** Scrub adapter-produced turn plans at the plugin boundary, before core attaches authority. */
export function publicChannelTurn<T extends object>(
  turn: T & { replyOptions?: GetReplyOptions },
): T {
  if (!("replyOptions" in turn)) {
    return turn;
  }
  return {
    ...turn,
    replyOptions: publicReplyOptions(turn.replyOptions),
  };
}

export function publicChannelTurnParams<
  TRaw,
  TResult,
  TDelivery extends import("../channels/turn/types.js").ChannelTurnDeliveryAdapter,
>(
  params: import("../channels/turn/types.js").RunChannelTurnParams<TRaw, TResult, TDelivery>,
): typeof params {
  return {
    ...params,
    adapter: {
      ...params.adapter,
      resolveTurn: async (...args) => publicChannelTurn(await params.adapter.resolveTurn(...args)),
    },
  };
}
