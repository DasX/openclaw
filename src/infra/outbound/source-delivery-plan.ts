// Source-delivery plans decide whether final output is visible through the
// message tool, direct fallback delivery, both, or neither.
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type {
  SourceDeliveryMessageToolTarget,
  SourceDeliveryOutcome,
  SourceDeliveryPlan,
  SourceDeliveryPlanReason,
  SourceDeliveryTarget,
  SourceVisibleDeliveryOwner,
} from "./source-delivery-plan.types.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
export type {
  SourceDeliveryOutcome,
  SourceDeliveryPlan,
  SourceDeliveryVisibleDelivery,
} from "./source-delivery-plan.types.js";

function isMessageToolOwnedDelivery(owner: SourceVisibleDeliveryOwner): boolean {
  return owner === "message_tool" || owner === "message_tool_then_direct_fallback";
}

function normalizeDeliveryTarget(channel: string, to: string): string {
  const toTrimmed = to.trim();
  return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}

function deliveryTargetsMatch(channel: string, targetTo: string, deliveryTo: string): boolean {
  const targetToTrimmed = targetTo.trim();
  const deliveryToTrimmed = deliveryTo.trim();
  if (targetToTrimmed === deliveryToTrimmed) {
    return true;
  }
  const targetPrefixed = targetToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const deliveryPrefixed = deliveryToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const targetKind = targetPrefixed?.[1]?.toLowerCase();
  const deliveryKind = deliveryPrefixed?.[1]?.toLowerCase();
  if (
    targetKind &&
    targetKind === deliveryKind &&
    ["channel", "conversation", "group", "user"].includes(targetKind)
  ) {
    // Provider-owned ID comparison can bypass generic target normalization.
    const targetId = targetPrefixed?.[2]?.trim();
    const deliveryId = deliveryPrefixed?.[2]?.trim();
    const comparison = getChannelPlugin(channel)?.messaging?.targetIdComparison;
    if (comparison === "case-sensitive") {
      return targetId === deliveryId;
    }
    if (comparison === "lowercase") {
      return targetId?.toLowerCase() === deliveryId?.toLowerCase();
    }
  }
  return (
    normalizeDeliveryTarget(channel, targetToTrimmed) ===
    normalizeDeliveryTarget(channel, deliveryToTrimmed)
  );
}

function normalizeDeliveryThreadId(threadId: string | number | undefined): string | undefined {
  return stringifyRouteThreadId(threadId)?.trim() || undefined;
}

function extractTopicThreadId(targetTo: string): string | undefined {
  return targetTo.match(/:topic:(\d+)$/i)?.[1];
}

/** Compares a message-tool target with the required source delivery target. */
export function sourceDeliveryTargetsMatch(
  target: SourceDeliveryMessageToolTarget,
  delivery: SourceDeliveryTarget,
): boolean {
  if (!delivery.channel || !delivery.to || !target.to) {
    return false;
  }
  const channel = delivery.channel.trim().toLowerCase();
  const provider = target.provider?.trim().toLowerCase();
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (delivery.accountId && target.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  // Strip :topic:NNN from message targets and normalize Feishu/Lark prefixes on
  // both sides so source-delivery suppression compares canonical IDs.
  if (!deliveryTargetsMatch(channel, target.to.replace(/:topic:\d+$/, ""), delivery.to)) {
    return false;
  }
  const deliveryThreadId = normalizeDeliveryThreadId(delivery.threadId);
  const targetThreadId =
    normalizeDeliveryThreadId(target.threadId) ?? extractTopicThreadId(target.to);
  if (!deliveryThreadId && !targetThreadId) {
    return true;
  }
  if (deliveryThreadId && !targetThreadId) {
    return target.threadImplicit === true && target.threadSuppressed !== true;
  }
  return deliveryThreadId === targetThreadId;
}

/** Builds a source delivery plan from ownership and fallback inputs. */
export function createSourceDeliveryPlan(params: {
  owner: SourceVisibleDeliveryOwner;
  reason: SourceDeliveryPlanReason;
  target?: SourceDeliveryTarget;
  messageToolEnabled?: boolean;
  messageToolForced?: boolean;
  requireExplicitMessageTarget?: boolean;
  requireExplicitMessageTargetEvidence?: boolean;
  directFallback?: boolean;
  skipFallbackWhenMessageToolSentToTarget?: boolean;
  fallbackBestEffort?: boolean;
  allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
}): SourceDeliveryPlan {
  const messageToolOwnsDelivery = isMessageToolOwnedDelivery(params.owner);
  const sourceReplyDeliveryMode = messageToolOwnsDelivery ? "message_tool_only" : undefined;
  const directDelivery =
    params.directFallback ??
    (params.owner === "direct_fallback" || params.owner === "message_tool_then_direct_fallback");
  return {
    owner: params.owner,
    reason: params.reason,
    target: params.target ?? {},
    normalFinal:
      sourceReplyDeliveryMode === "message_tool_only" || params.owner === "none"
        ? "private"
        : "visible",
    sourceReplyDeliveryMode,
    messageTool: {
      enabled: params.messageToolEnabled ?? messageToolOwnsDelivery,
      force: params.messageToolForced ?? messageToolOwnsDelivery,
      requireExplicitTarget: params.requireExplicitMessageTarget ?? false,
      requireExplicitTargetEvidence: params.requireExplicitMessageTargetEvidence ?? false,
      defaultTarget: Boolean(params.target?.channel || params.target?.to),
    },
    fallback: {
      directDelivery,
      skipWhenMessageToolSentToTarget:
        params.skipFallbackWhenMessageToolSentToTarget ??
        params.owner === "message_tool_then_direct_fallback",
      bestEffort: params.fallbackBestEffort ?? false,
    },
    progress: {
      allowCallbacksWhenSourceDeliverySuppressed:
        params.allowProgressCallbacksWhenSourceDeliverySuppressed ?? false,
    },
  };
}

function resolveImplicitMessageToolDeliveryTarget(
  plan: SourceDeliveryPlan,
): SourceDeliveryMessageToolTarget | undefined {
  if (!plan.target.channel || !plan.target.to) {
    return undefined;
  }
  const threadId = stringifyRouteThreadId(plan.target.threadId);
  return {
    tool: "message",
    provider: plan.target.channel,
    ...(plan.target.accountId ? { accountId: plan.target.accountId } : {}),
    ...(plan.target.to ? { to: plan.target.to } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

/** Evaluates whether observed message-tool sends satisfy the source delivery plan. */
export function resolveSourceDeliveryOutcome(
  plan: SourceDeliveryPlan,
  params: {
    didSendViaMessageTool?: boolean;
    messageToolSentTargets?: SourceDeliveryMessageToolTarget[];
  },
): SourceDeliveryOutcome {
  const didSendViaMessageTool = params.didSendViaMessageTool === true;
  const explicitTargets = params.messageToolSentTargets ?? [];
  // Cron completion accounting needs concrete target evidence. Legacy
  // message-tool-owned flows may still use the plan target as the implicit send.
  const sentTargets =
    explicitTargets.length > 0
      ? explicitTargets
      : didSendViaMessageTool && !plan.messageTool.requireExplicitTargetEvidence
        ? [resolveImplicitMessageToolDeliveryTarget(plan)].filter(
            (target): target is SourceDeliveryMessageToolTarget => Boolean(target),
          )
        : [];
  const visibleDeliveries = sentTargets.map((target) => ({
    via: "message_tool" as const,
    target,
    verifiedTarget: sourceDeliveryTargetsMatch(target, plan.target),
  }));
  const hasVerifiedMessageToolDelivery = visibleDeliveries.some(
    (delivery) => didSendViaMessageTool && delivery.verifiedTarget,
  );
  return {
    visibleDeliveries,
    verifiedMessageToolDelivery: hasVerifiedMessageToolDelivery,
    satisfiesSourceDelivery:
      plan.fallback.skipWhenMessageToolSentToTarget && hasVerifiedMessageToolDelivery,
    unverifiedMessageToolDelivery:
      didSendViaMessageTool && sentTargets.length > 0 && !hasVerifiedMessageToolDelivery,
  };
}
