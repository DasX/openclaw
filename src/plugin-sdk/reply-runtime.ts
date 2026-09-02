import {
  dispatchInboundMessageCore,
  dispatchInboundMessageWithBufferedDispatcherCore as dispatchBufferedCore,
  dispatchInboundMessageWithDispatcherCore as dispatchPlainCore,
} from "../auto-reply/dispatch.js";
import { getReplyFromConfigCore } from "../auto-reply/reply/get-reply.js";
import {
  dispatchReplyWithBufferedBlockDispatcherCore,
  dispatchReplyWithDispatcherCore,
} from "../auto-reply/reply/provider-dispatcher.js";
import { publicReplyOptions } from "./reply-options.js";
// Shared agent/reply runtime helpers for channel plugins. Keep channel plugins
// off direct src/auto-reply imports by routing common reply primitives here.

export {
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
export type { ChunkMode } from "../auto-reply/chunk.js";

export { settleReplyDispatcher } from "../auto-reply/dispatch.js";
export const dispatchInboundMessage: typeof dispatchInboundMessageCore = (params) =>
  dispatchInboundMessageCore({ ...params, replyOptions: publicReplyOptions(params.replyOptions) });
export const dispatchInboundMessageWithBufferedDispatcher: typeof dispatchBufferedCore = (params) =>
  dispatchBufferedCore({ ...params, replyOptions: publicReplyOptions(params.replyOptions) });
export const dispatchInboundMessageWithDispatcher: typeof dispatchPlainCore = (params) =>
  dispatchPlainCore({ ...params, replyOptions: publicReplyOptions(params.replyOptions) });
export {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../auto-reply/group-activation.js";
export {
  HEARTBEAT_PROMPT,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  resolveHeartbeatPromptCore,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
export { resolveHeartbeatReplyPayload } from "../auto-reply/heartbeat-reply-payload.js";

/** Public SDK boundary: scheduler and reply-owner capabilities stay host-private. */
export const getReplyFromConfig: typeof getReplyFromConfigCore = (ctx, opts, config) =>
  getReplyFromConfigCore(ctx, publicReplyOptions(opts), config);
export { HEARTBEAT_TOKEN, isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
export { isAbortRequestText } from "../auto-reply/reply/abort.js";
export { isBtwRequestText } from "../auto-reply/reply/btw-command.js";
export { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
export { finalizeInboundContextForSdk as finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";

export const dispatchReplyWithBufferedBlockDispatcher: typeof dispatchReplyWithBufferedBlockDispatcherCore =
  (params) =>
    dispatchReplyWithBufferedBlockDispatcherCore({
      ...params,
      replyOptions: publicReplyOptions(params.replyOptions),
    });
export const dispatchReplyWithDispatcher: typeof dispatchReplyWithDispatcherCore = (params) =>
  dispatchReplyWithDispatcherCore({
    ...params,
    replyOptions: publicReplyOptions(params.replyOptions),
  });
export {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
} from "../auto-reply/reply/reply-dispatcher.js";
export type {
  ReplyDispatchBeforeDeliverOptions,
  ReplyDispatchKind,
  ReplyDispatcher,
  ReplyFollowupAdmissionBarrierTimeoutPolicy,
} from "../auto-reply/reply/reply-dispatcher.types.js";
export type {
  ReplyDispatcherOptions,
  ReplyDispatcherWithTypingOptions,
} from "../auto-reply/reply/reply-dispatcher.js";
export { createReplyReferencePlanner } from "../auto-reply/reply/reply-reference.js";
export type {
  GetReplyOptions,
  BlockReplyContext,
  SourceReplyDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
export type { ReplyPayload } from "./reply-payload.js";
export type {
  ChannelStructuredContextEntry,
  FinalizedMsgContext,
  MsgContext,
  UntrustedStructuredContextEntry,
} from "../auto-reply/templating.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { generateConversationLabel } from "../auto-reply/reply/conversation-label-generator.js";
export type { ConversationLabelParams } from "../auto-reply/reply/conversation-label-generator.js";
