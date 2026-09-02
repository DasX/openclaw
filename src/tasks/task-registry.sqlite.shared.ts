// Shares SQLite row mapping helpers between task registry persistence modules.
import { safeParseJson } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "../../packages/gateway-protocol/src/schema/closed-object.js";
import {
  SessionPermissionModeSchema,
  SessionToolOverridesSchema,
} from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { isRecord } from "../utils.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { TaskDeliveryState } from "./task-registry.types.js";

const TaskRequesterTargetSchema = closedObject({
  agentId: Type.String(),
  sessionKey: Type.String(),
  sessionId: Type.String(),
  storePath: Type.Optional(Type.String()),
  lifecycleRevision: Type.Optional(Type.String()),
  toolsAllow: Type.Optional(Type.Array(Type.String())),
  settings: Type.Optional(
    closedObject({
      permissionMode: Type.Optional(SessionPermissionModeSchema),
      toolOverrides: Type.Optional(SessionToolOverridesSchema),
    }),
  ),
  deliveryContext: Type.Optional(
    closedObject({
      channel: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      accountId: Type.Optional(Type.String()),
      threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
      deliveryIntent: Type.Optional(
        closedObject({
          id: Type.String(),
          kind: Type.Literal("outbound_queue"),
          queuePolicy: Type.Optional(
            Type.Union([Type.Literal("required"), Type.Literal("best_effort")]),
          ),
        }),
      ),
    }),
  ),
});

/** Reject damaged constraints rather than silently widening a deferred task's permissions. */
export function parseTaskRequesterTarget(value: unknown): TaskDeliveryState["requesterTarget"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Value.Check(TaskRequesterTargetSchema, value)) {
    throw new Error("Invalid task requester target in persisted delivery state");
  }
  return value;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Persisted JSON columns are typed by the receiving field.
export function parseSqliteJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  return safeParseJson(raw) as T | undefined;
}

export function parseDeliveryContextJson(raw: string | null): DeliveryContext | undefined {
  const parsed = parseSqliteJsonValue<unknown>(raw);
  if (!isRecord(parsed)) {
    return undefined;
  }
  return normalizeDeliveryContext({
    channel: typeof parsed.channel === "string" ? parsed.channel : undefined,
    to: typeof parsed.to === "string" ? parsed.to : undefined,
    accountId: typeof parsed.accountId === "string" ? parsed.accountId : undefined,
    threadId:
      typeof parsed.threadId === "string" || typeof parsed.threadId === "number"
        ? parsed.threadId
        : undefined,
  });
}
