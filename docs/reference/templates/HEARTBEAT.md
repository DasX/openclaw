---
summary: "Migration guide for the retired HEARTBEAT.md workspace file"
title: "Retired HEARTBEAT.md workspace file"
read_when:
  - Migrating an older workspace that still has HEARTBEAT.md
---

# HEARTBEAT.md is retired

OpenClaw no longer creates `HEARTBEAT.md` in new workspaces or reads it at runtime. Existing checklists migrate to an ordinary automation job's scratch in the shared state database; the job owns its schedule and execution settings.

Manage the current scratch with the monitor job id from `openclaw cron list --all`:

```bash
openclaw cron scratch <jobId>
openclaw cron scratch <jobId> --set "..."
openclaw cron scratch <jobId> --file notes.md
openclaw cron scratch <jobId> --unset
```

If an older workspace still contains `HEARTBEAT.md`, run `openclaw doctor --fix`. Doctor imports its instructions into job scratch and converts supported legacy `tasks:` entries into ordinary jobs before archiving the original. Existing job IDs, history, scratch revisions and tombstones, disabled state, and scheduling anchors are preserved. Ambiguous or blocked input remains recoverable; follow Doctor's diagnostic instead of deleting it manually.

## Related

- [Heartbeat migration](/gateway/heartbeat)
- [Cron CLI](/cli/cron)
- [Doctor](/cli/doctor)
- [Retired heartbeat configuration](/gateway/config-agents#retired-heartbeat-configuration)
