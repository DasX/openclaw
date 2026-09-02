# Planned database changes

Track accepted database work that is intentionally deferred here. This list does
not authorize a schema bump or migration. Follow the
[database schema review checkpoint](../../docs/reference/database-schemas.md#review-checkpoint-for-material-changes)
before implementation; the canonical schema files and version contracts describe
what actually ships.

For each item, record its owner, affected store, data disposition, prerequisites,
removal boundary, and verification. Link the implementing issue or PR when it
exists, and remove the item only after the change and its proof land.

## Retire the heartbeat outcomes table

- **Status:** deferred to the next explicitly approved agent-schema bump. Keep
  agent schema 19 and the existing table shape during heartbeat runtime retirement.
- **Owner:** agent-state and automation/session migration owners; tracked in
  [heartbeat retirement](https://github.com/openclaw/openclaw/issues/134994).
- **Store:** per-agent database; `heartbeat_outcomes` in
  `openclaw-agent-schema.sql`.
- **Reason:** the heartbeat execution subsystem is being replaced by ordinary
  automations and session follow-ups. Keeping its unused table temporarily avoids
  advancing the agent schema solely for physical cleanup.
- **Data disposition:** migrate any still-relevant pending outcome into canonical
  session context with an idempotent occurrence identity. Verify durable destination
  ownership before retiring source rows; do not discard unsurfaced useful context.
- **Prerequisites:** no steady-state heartbeat outcome readers or writers; repeated
  and interrupted migration preserves context without duplicate delivery; existing
  session reset/deletion and retention rules still apply.
- **Cleanup:** remove the table declaration and schema/type/test references, and
  replace the `heartbeat_outcomes` delimiter used by
  `openclaw-agent-session-sharing-schema.ts` and
  `openclaw-agent-progress-card-schema.ts`. Do not leave dangling schema-fragment
  anchors.
- **Verification:** migrate copied populated and empty databases; interrupt and
  retry context transfer; reopen with the candidate; verify retained session data,
  pending context, and integrity; prove older readers reject the new schema.
- **Rollback:** use a verified WAL-aware pre-upgrade backup in a separate state
  directory. Never lower schema version markers or reconstruct deleted data from
  assumptions.

The shared-state schema fence for new automation policy is a separate migration;
its approval does not authorize dropping this agent-owned table.
