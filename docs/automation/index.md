---
doc-schema-version: 1
summary: "Overview of automation mechanisms: tasks, automations, hooks, standing orders, and Task Flow"
read_when:
  - Deciding how to automate work with OpenClaw
  - Choosing between scheduled jobs, session events, hooks, and standing orders
  - Looking for the right automation entry point
title: "Automation"
---

OpenClaw runs work in the background through scheduled jobs, session events,
hooks, and standing instructions. Use this page to pick the right mechanism.

## Quick decision guide

| Use case                                         | Recommended                                | Why                                                        |
| ------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| Send a daily report at 9 AM                      | Automations                                | Explicit timing, context, and delivery                     |
| Remind me in 20 minutes                          | Automations                                | One-shot schedule and run history                          |
| Run weekly deep analysis                         | Automations                                | Independent instructions and model selection               |
| Check an inbox every 30 minutes                  | Automations                                | Independent recurring schedule                             |
| Surface periodic updates when the agent is idle  | Automations                                | Per-job idle, window, scratch, and delivery policy         |
| Follow up when a background command finishes     | Session events                             | Completion reaches its originating session without polling |
| Trigger safely on new IMAP email                 | IMAP plugin                                | Sender-gated isolated reader sessions                      |
| Inspect subagent or ACP work                     | Background Tasks                           | Detached-work lifecycle and outcomes                       |
| Audit scheduled work                             | Automation run history                     | Execution, delivery, suppression, and failure records      |
| Orchestrate a multi-step flow                    | Task Flow                                  | Durable orchestration with revision tracking               |
| Run a script on session reset                    | Hooks                                      | Internal lifecycle handlers                                |
| Trigger an agent from an external service        | [Webhooks](/automation/cron-jobs#webhooks) | Authenticated ingress                                      |
| Execute code on tool calls                       | Plugin hooks                               | Typed plugin lifecycle handlers                            |
| Give the agent persistent operating instructions | Standing Orders                            | Instructions carried into agent context                    |

<a id="automations-vs-heartbeat" />

### Scheduled checks and immediate events

Use an automation when work has a schedule. Each job owns its instructions,
context, model, scratch, and delivery settings. Background monitoring is an
ordinary automation, not a second execution subsystem.

Use a session event when a producer has already observed something: a command
finished, a task became blocked, or a restart completed. The producer retains
its routing and delivery responsibility; normal session execution handles any
required follow-up. Such events do not depend on a periodic monitor or an
enabled cron scheduler.

Older installations called the built-in periodic monitor **heartbeat**. Doctor
converts those monitors into ordinary editable jobs. See
[Heartbeat migration](/gateway/heartbeat) for upgrade and legacy-client details.

## Core concepts

### Automations

Automations are OpenClaw's built-in scheduler for recurring and one-shot work.
Jobs persist in the shared state database, start at the right time, and can
deliver output to a chat channel or webhook. They support one-shot reminders,
intervals, cron expressions, and authored event-driven sources.

A job can use shared session context, fresh isolated context, or a detached run
bound to the creating conversation. Optional per-job policies let background
checks yield to foreground work, respect active hours, and remain silent when
nothing needs attention. Inspect the job's run history to distinguish a quiet
success from a failure or intentional skip.

See [Automations](/automation/cron-jobs).

### Tasks

The background task ledger tracks detached work: ACP runs, subagent spawns,
automation runs, and CLI operations. Tasks are records, not schedulers. Use
`openclaw tasks list` and `openclaw tasks audit` to inspect them.

See [Background Tasks](/automation/tasks).

### Task Flow

Task Flow manages durable orchestration with managed and mirrored sync modes,
revision tracking, and `openclaw tasks flow list|show|cancel` inspection. It
coordinates work above the background task ledger rather than replacing job
scheduling or session execution.

See [Task Flow](/automation/taskflow).

### Standing orders

Standing orders grant the agent permanent operating authority for defined
programs. They live in workspace files such as `AGENTS.md` and are injected
into agent context. Combine them with automations for time-based enforcement;
instructions alone do not create a schedule.

See [Standing Orders](/automation/standing-orders).

### Hooks

Internal hooks are event-driven scripts triggered by agent lifecycle events
such as `/new`, `/reset`, `/stop`, compaction, startup, and message flow. They
are discovered from hook directories and managed with `openclaw hooks`.
For in-process tool-call interception, use [Plugin hooks](/plugins/hooks).

See [Hooks](/automation/hooks).

## Retired inferred commitments

The inferred commitments experiment has been removed: OpenClaw no longer
extracts follow-ups from conversations for automatic delivery. The
`openclaw commitments` maintenance CLI is also gone. The database migration
discards the old commitment rows and removes their table and indexes.

For reminders or scheduled work, create an explicit
[automation](/automation/cron-jobs). Automations have a schedule and instructions
you choose; they do not restore inferred follow-ups.

## Related

- [Automations](/automation/cron-jobs) — scheduling, execution, delivery, and history
- [IMAP email trigger](/automation/imap) — sender-gated isolated reader sessions
- [Background Tasks](/automation/tasks) — detached-work tracking
- [Task Flow](/automation/taskflow) — durable multi-step orchestration
- [Hooks](/automation/hooks) — event-driven lifecycle scripts
- [Plugin hooks](/plugins/hooks) — typed plugin handlers
- [Standing Orders](/automation/standing-orders) — persistent agent instructions
- [Heartbeat migration](/gateway/heartbeat) — upgrade older monitors and integrations
- [Configuration Reference](/gateway/configuration-reference) — configuration keys
