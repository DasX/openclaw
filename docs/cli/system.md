---
summary: "CLI reference for `openclaw system` (session events, legacy monitor controls, presence)"
read_when:
  - You want to enqueue a system event without creating a cron job
  - You need the deprecated controls for migrated heartbeat monitors
  - You want to inspect system presence entries
title: "System"
---

# `openclaw system`

System-level helpers for the Gateway: submit session events and view presence.
Legacy heartbeat controls remain as deprecated adapters for migrated monitor
jobs; use `openclaw automations` for new job management.

All `system` subcommands use Gateway RPC and accept the shared client flags:

| Flag              | Default                              | Description                                                                                                                                                                                            |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--url <url>`     | `gateway.remote.url` when configured | Gateway WebSocket URL.                                                                                                                                                                                 |
| `--token <token>` | none                                 | Gateway token (if required).                                                                                                                                                                           |
| `--timeout <ms>`  | `30000`                              | RPC timeout in milliseconds.                                                                                                                                                                           |
| `--expect-final`  | off                                  | Wait for final response (agent).                                                                                                                                                                       |
| `--json`          | off                                  | Output JSON. `heartbeat last/enable/disable` and `system presence` always print the raw RPC JSON payload regardless of this flag; `system event` uses it to switch between JSON and a plain `ok` line. |

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system event --text "Check for urgent follow-ups" --mode now --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
openclaw automations list --all
openclaw system presence
```

## `system event`

Submit a system event to the **main** session by default. Use `--mode now`
to request normal session processing without a periodic monitor. The legacy
`next-heartbeat` mode (the compatibility default) defers processing to a valid
scheduled monitor job; it returns an actionable result when that target is
unavailable. Prefer explicit automation schedules or `--mode now` for new calls.

Pass `--session-key` to target a specific session, for example to relay an
async-task completion back to the channel that started it.

<Note>
**Legacy timing exception with `--session-key`:** when `--session-key` is
supplied, `--mode next-heartbeat` retains its immediate targeted behavior
instead of waiting for a periodic job. Use `--mode now` to make that intent
explicit. For delayed work, create an automation with its own schedule rather
than depending on the legacy wake-mode spelling.
</Note>

Flags:

- `--text <text>`: required system event text.
- `--mode <mode>`: `now` or `next-heartbeat` (default).
- `--session-key <sessionKey>`: optional; target a specific agent session
  instead of the agent's main session. Keys that do not belong to the
  resolved agent fall back to the agent's main session.

## `system heartbeat last|enable|disable`

- `last`: show the deprecated heartbeat event projection from canonical automation/session state.
- `enable`: enable the corresponding converted or default monitor jobs.
- `disable`: pause those monitor jobs, not every automation.

These commands do not control a separate execution engine or gate immediate
session follow-ups. Prefer `openclaw automations show|enable|disable <job-id>`
for job management. See [Heartbeat migration](/gateway/heartbeat).

## `system presence`

List the current system presence entries the Gateway knows about (nodes,
instances, and similar status lines).

## Notes

- Requires a running Gateway reachable by your current config (local or
  remote).
- System events are ephemeral and not persisted across restarts.

## Related

- [CLI reference](/cli)
- [Automations CLI](/cli/cron)
- [Heartbeat migration](/gateway/heartbeat)
