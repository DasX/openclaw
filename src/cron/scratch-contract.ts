/** Publicly stable limits for private per-job scratch content. */
export const CRON_JOB_SCRATCH_MAX_BYTES = 256 * 1024;

/** Missing scratch runs; an explicit checklist containing only scaffolding does not. */
export function isCronScratchEffectivelyEmpty(content: string | undefined): boolean {
  if (content === undefined) {
    return false;
  }
  const withoutComments = content.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  return withoutComments.split("\n").every((line) => {
    const text = line.trim();
    return (
      !text ||
      /^#+(\s|$)/.test(text) ||
      /^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(text) ||
      /^```[A-Za-z0-9_-]*$/.test(text)
    );
  });
}

export function assertCronJobScratchContent(content: string): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > CRON_JOB_SCRATCH_MAX_BYTES) {
    throw new Error(
      `cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes (${sizeBytes} bytes provided)`,
    );
  }
}
