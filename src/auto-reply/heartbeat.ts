/** Historical transcript/token recognition and deprecated SDK prompt constants only. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../shared/regexp.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN, isSilentReplyPayloadText } from "./tokens.js";

// Historical prompt bytes for shipped SDK exports and transcript classification only.
// Keep it tight and avoid encouraging the model to invent/rehash "open loops" from prior chat context.
const HEARTBEAT_CRON_TASK_GUIDANCE =
  "Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch.";
const HEARTBEAT_CONTEXT_PROMPT = `Follow the heartbeat monitor scratch context when provided. ${HEARTBEAT_CRON_TASK_GUIDANCE} Do not infer or repeat old tasks from prior chats.`;
/** @deprecated Historical SDK prompt; ordinary automations supply their own instructions. */
export const HEARTBEAT_PROMPT = `${HEARTBEAT_CONTEXT_PROMPT} If nothing needs attention, reply ${SILENT_REPLY_TOKEN}.`;
export const HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS =
  "Use heartbeat_respond to report the wake outcome. Set notify=false when nothing needs the user's attention. Set notify=true with notificationText only when the user should be interrupted.";
export const HEARTBEAT_RESPONSE_TOOL_PROMPT = `${HEARTBEAT_CONTEXT_PROMPT} ${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`;
export const HEARTBEAT_TRANSCRIPT_PROMPT = "[OpenClaw heartbeat poll]";
export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

/** @deprecated Historical SDK prompt resolver; never used to author an ordinary turn. */
export function resolveHeartbeatPromptCore(raw?: string): string {
  const trimmed = normalizeOptionalString(raw) ?? "";
  return trimmed || HEARTBEAT_PROMPT;
}

/** Reconstruct a historical response-tool prompt for transcript classification. */
export function resolveHeartbeatPromptForResponseTool(raw?: string): string {
  const prompt = normalizeOptionalString(raw);
  if (!prompt) {
    return HEARTBEAT_RESPONSE_TOOL_PROMPT;
  }
  return prompt.includes(HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS)
    ? prompt
    : `${prompt}\n\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`;
}

type StripHeartbeatMode = "heartbeat" | "message";

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    // Strip the token when it appears at the end of the text.
    // Also strip up to 4 trailing non-word characters the model may have appended
    // (e.g. ".", "!!!", "---"). Keep trailing punctuation only when real
    // sentence text exists before the token.
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

/** Strips HEARTBEAT_OK acknowledgements and decides whether visible notification is needed. */
export function stripHeartbeatToken(
  raw?: string,
  opts: { mode?: StripHeartbeatMode; maxAckChars?: number } = {},
) {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  // Markup cleanup inserts spaces or removes edge wrappers; it cannot create this token.
  if (!trimmed.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const mode: StripHeartbeatMode = opts.mode ?? "message";
  const maxAckCharsRaw = opts.maxAckChars;
  const parsedAckChars =
    typeof maxAckCharsRaw === "string" ? Number(maxAckCharsRaw) : maxAckCharsRaw;
  const maxAckChars = Math.max(
    0,
    typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars)
      ? parsedAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  // Normalize lightweight markup so HEARTBEAT_OK wrapped in HTML/Markdown
  // (e.g., <b>HEARTBEAT_OK</b> or **HEARTBEAT_OK**) still strips.
  const stripMarkup = (text: string) =>
    text
      // Drop HTML tags.
      .replace(/<[^>]*>/g, " ")
      // Decode common nbsp variant.
      .replace(/&nbsp;/gi, " ")
      // Remove markdown-ish wrappers at the edges.
      .replace(/^[*`~_]+/, "")
      .replace(/[*`~_]+$/, "");

  const trimmedNormalized = stripMarkup(trimmed);

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (mode === "heartbeat") {
    if (rest.length <= maxAckChars) {
      return { shouldSkip: true, text: "", didStrip: true };
    }
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}

/** Recognizes canonical silent replies and backwards-compatible heartbeat acknowledgements. */
export function isHeartbeatAcknowledgementText(
  text: string | undefined,
  maxAckChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
): boolean {
  return (
    isSilentReplyPayloadText(text) ||
    stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars }).shouldSkip
  );
}
