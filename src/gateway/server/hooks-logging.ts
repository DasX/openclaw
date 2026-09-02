import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactToolPayloadText } from "../../logging/redact.js";

export function sanitizeHookConsoleValue(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const withoutControlChars = Array.from(normalized, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  return truncateUtf16Safe(withoutControlChars.replace(/\s+/gu, " ").trim(), 500);
}

type HookLogMetadata = Record<string, string | boolean | undefined>;

export function sanitizeHookLogMetadata(meta: HookLogMetadata): HookLogMetadata {
  return Object.fromEntries(
    Object.entries(meta)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [
        key,
        // Redact the raw field first: truncation or folding a multiline secret can defeat masking.
        typeof value === "string"
          ? sanitizeHookConsoleValue(redactToolPayloadText(value).replace(/\p{Cc}/gu, " "))
          : value,
      ]),
  );
}
