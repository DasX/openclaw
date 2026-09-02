/** Historical exec completion text classifier for transcript/context readers. */
export function isExecCompletionEvent(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    /^exec finished(?::|\s*\()/i.test(trimmed) ||
    /^exec (completed|failed) \(([a-z0-9_-]{1,64}), (code -?\d+|signal [^)]+)\)(?: :: ([\s\S]*))?$/i.test(
      trimmed,
    )
  );
}
