import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";

export function appendCronUnattendedRunPreamble(
  commandBody: string,
  opts: { externalHook: boolean },
) {
  const core = `This is an unattended scheduled run. Nobody is present to clarify or approve, so complete the task with what you have. Your final reply is the deliverable — not a plan, an acknowledgement, or a request for input. If nothing needs doing, reply exactly ${SILENT_REPLY_TOKEN}. If something failed, state plainly what failed and what you tried — the scheduler owns retries and failure alerts.`;
  const trustedExtra =
    " Where the job's own instructions conflict with this preamble, the job's instructions win (a question or plan the job explicitly requests is a valid deliverable). If this job is no longer needed, remove it if your available tools allow.";
  return `${commandBody}\n\n${core}${opts.externalHook ? "" : trustedExtra}`;
}
