import { isRecord } from "../../utils.js";

export function formatCronTerminalPresentation(
  params: unknown,
  result: unknown,
): { text: string } | undefined {
  if (!isRecord(params) || !isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  switch (params.action) {
    case "status": {
      const enabled = result.details.enabled === true ? "yes" : "no";
      return { text: `Automations scheduler status.\nEnabled: ${enabled}` };
    }
    case "list": {
      const total =
        typeof result.details.total === "number" &&
        Number.isFinite(result.details.total) &&
        result.details.total >= 0
          ? Math.floor(result.details.total)
          : undefined;
      const count =
        total ?? (Array.isArray(result.details.jobs) ? result.details.jobs.length : undefined);
      return count === undefined
        ? { text: "Automations listed." }
        : { text: `Automations listed.\nCount: ${count}` };
    }
    case "get":
      return { text: "Automation loaded." };
    case "runs": {
      const entries = Array.isArray(result.details.entries)
        ? result.details.entries.length
        : undefined;
      return entries === undefined
        ? { text: "Automation run history loaded." }
        : { text: `Automation run history loaded.\nCount: ${entries}` };
    }
    default:
      return undefined;
  }
}

export function buildCronToolDescription(params: {
  triggersEnabled: boolean;
  selfScoped?: boolean;
  pacingEnabled?: boolean;
  activeRun?: boolean;
}): string {
  if (params.selfScoped) {
    if (!params.activeRun) {
      return "Inspect or remove this automation only. Run-scoped scratch and result actions become available only during an admitted execution.";
    }
    return (
      "Manage this automation only: status/list/get/runs inspect its job and history; remove deletes it permanently. scratch_get reads its checklist and revision; scratch_set replaces or clears content and requires expectedRevision from the read (CAS conflicts require rereading). record_result records one concise outcome (no_change, progress, done, blocked, needs_attention) and summary for this run. NO_REPLY keeps the user-facing response silent. No other jobs can be changed from an automation run." +
      (params.pacingEnabled
        ? " next_check with in:<duration> proposes this paced job's next delay."
        : "")
    );
  }
  const addFields = params.triggersEnabled
    ? "{name?,schedule,payload,sessionTarget?,pacing?,trigger?,delivery?,enabled?}"
    : "{name?,schedule,payload,sessionTarget?,pacing?,delivery?,enabled?}";
  const streamScheduleLine = params.triggersEnabled
    ? '\n- {kind:"stream",command:[argv],mode?:"line"|"match",match?}: fires on supervised process output; disabled only when cron.triggers.enabled=false.'
    : "";
  const scriptPayloadLine = params.triggersEnabled
    ? '\n- script {kind:"script",script,timeoutSeconds?,toolBudget?}: main|isolated only; disabled only when cron.triggers.enabled=false.'
    : "";
  const triggerSection = params.triggersEnabled
    ? `TRIGGER (condition watcher on every/cron): {script,once?}; available unless cron.triggers.enabled=false — if off, say so; never model-poll instead. Quiet headless check, no model; 30s/5 tool calls/16KB state. Read frozen trigger.state, return json({fire,message?,state?}) with NEW state; dedupe via state, never memory. fire:false saves state only. fire:true runs payload; message is that run's entire context — self-contained. Fire on failures/timeouts too; success-only watchers look healthy when broken. Script stays read-only; actions belong in payload. once:true disables after first fire. Code Mode: await exec({command:"..."}).`
    : `TRIGGERS DISABLED (cron.triggers.enabled=false): condition triggers, script payloads, and stream schedules are unavailable here. Omit trigger; use plain time-based schedules. If the user asks for a conditional watcher, say it is unsupported — never model-poll instead, and never silently create an unconditional job in its place.`;
  const silentWatcherCue = params.triggersEnabled ? ' Silent watcher=>mode:"none".' : "";
  return `Gateway scheduler: reminders, delayed self-wakeups, loops, recurring work${params.triggersEnabled ? ", event watchers" : ""}. Never exec sleep/poll as timer.

ACTIONS: status | list [includeDisabled,limit?,offset?] (use nextOffset for the next page) | get jobId | add job | update jobId job (partial: only supplied fields change; null clears) | remove jobId | run jobId (runMode "force"=now) | runs jobId = history | wake text mode?:"now"|"next-heartbeat"(default) nudges a caller-owned lane (sessionKey/agentId to pick another).

ADD: ${addFields}. Required: schedule+payload.

SCHEDULE:
- {kind:"at",at:"ISO-8601"} one-shot; no tz=UTC; auto-deletes after successful completion: delivery confirmed, not requested, intentionally silent, or explicitly bestEffort. Failed/unknown required delivery retains it disabled.
- {kind:"every",everyMs}.
- {kind:"cron",expr,tz?:"IANA"}: expr is wall time in tz; never pre-convert to UTC; no tz=gateway host local. 18:00 Shanghai => {expr:"0 18 * * *",tz:"Asia/Shanghai"}.${streamScheduleLine}

TARGET+PAYLOAD:
- "current" (agentTurn default) = this conversation: the run stays detached, reads bounded chat context, then commits its final visible assistant result to this conversation's durable history. Self-wakeup/"continue later"/loop = at|every + agentTurn + current.
- "isolated" = fresh detached session (shows in \`openclaw tasks\`); standalone background work.
- "main" = normal main-session follow-up; payload {kind:"systemEvent",text} (systemEvent default target). The run waits for actual execution and delivery.
- "session:<key>" = named session.
- agentTurn {kind:"agentTurn",message,model?,thinking?,timeoutSeconds?}; timeoutSeconds 0=none.
- Inherited configured MCP authority includes only model-callable tools; interactive app-view-only capabilities are excluded from headless jobs.${scriptPayloadLine}

PACED LOOP: recurring job + pacing{min?,max?} durations ("15m","4h"; at least one). Inside its run, job calls next_check in:"<dur>" to set the next delay (clamped to bounds, measured from run end; failed runs keep normal backoff). Adaptive polling: tighten when active, back off when quiet.

${triggerSection}

DELIVERY {mode:"none"|"announce"|"webhook",channel?,to?,threadId?,bestEffort?,completionDestination?}: where detached run output goes. Omitted=announce (current=>canonical session commit, plus one normal channel send for external chats; isolated=>last route; set channel/to for a specific chat — no messaging tool inside the run). A current announce succeeds only after its history commit; WebChat observes that commit live and after reconnect without another user message.${silentWatcherCue} webhook posts finished-run event (successful empty summary is intentional silence, no POST) to URL in \`to\`. To keep announce delivery and also POST completion, use mode:"announce" with completionDestination:{mode:"webhook",to:"https://..."}.

FAILURE ALERTS: jobs with a failure route default to alerting after 2 consecutive execution failures with a 1h cooldown. Route order: job failureAlert fields, delivery.failureDestination over global cron.failureAlert destination fields, then primary announce. failureAlert:false disables execution/delivery alerts, not the auto-disable safety notice; a failureAlert object activates/tunes. bestEffort suppresses inherited execution alerts. Required completion-delivery failure uses only an alternate route, bypasses after, and shares the execution-alert cooldown from the first failure; it does not increment the execution streak.

Optional job policy: activeHours{start,end,timezone?} is an end-exclusive execution window (including manual runs); idleOnly yields to foreground work. delivery.target:"owner" resolves the owner DM dynamically, never the last group; delivery.directPolicy:"block" prohibits DMs. agentTurn skipIfScratchEmpty skips an explicitly empty checklist, not missing scratch. jobId canonical (id=compat). contextMessages 0-10 embeds recent chat lines into reminder text.`;
}
