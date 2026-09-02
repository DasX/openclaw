// Regression for the copied shared-state upgrade reported from 2026.6.1-beta.1.
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../src/state/openclaw-state-schema.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const HISTORICAL_DEVICE_BOOTSTRAP_TOKENS_SQL = `
CREATE TABLE device_bootstrap_tokens (
  token_key TEXT NOT NULL PRIMARY KEY,
  token TEXT NOT NULL,
  ts INTEGER NOT NULL,
  device_id TEXT,
  public_key TEXT,
  profile_json TEXT,
  redeemed_profile_json TEXT,
  pending_profile_json TEXT,
  issued_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER
);

CREATE INDEX idx_device_bootstrap_tokens_ts
  ON device_bootstrap_tokens(ts);
`;

const HISTORICAL_OPERATOR_APPROVALS_SQL = `
CREATE TABLE operator_approvals (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(approval_id) > 0 AND approval_id NOT IN ('.', '..')
  ),
  resolution_ref TEXT NOT NULL CHECK (
    length(resolution_ref) = 43 AND resolution_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('exec', 'plugin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  presentation_json TEXT NOT NULL,
  requested_by_device_id TEXT,
  requested_by_client_id TEXT,
  requested_by_device_token_auth INTEGER NOT NULL DEFAULT 0,
  reviewer_device_ids_json TEXT NOT NULL,
  source_agent_id TEXT,
  source_session_key TEXT,
  source_session_id TEXT,
  source_run_id TEXT,
  source_tool_call_id TEXT,
  source_tool_name TEXT,
  audience_session_keys_json TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('allow-once', 'allow-always', 'deny')),
  terminal_reason TEXT CHECK (
    terminal_reason IN (
      'user',
      'timeout',
      'malformed-verdict',
      'no-route',
      'run-aborted',
      'gateway-restart',
      'storage-corrupt'
    )
  ),
  resolved_at_ms INTEGER,
  resolver_kind TEXT CHECK (resolver_kind IN ('device', 'channel', 'runtime', 'system')),
  resolver_id TEXT,
  consumed_at_ms INTEGER,
  consumed_by TEXT,
  CHECK (expires_at_ms >= created_at_ms),
  CHECK (updated_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms <= updated_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= resolved_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms <= updated_at_ms),
  CHECK (requested_by_device_token_auth IN (0, 1)),
  CHECK (
    (
      status = 'pending'
      AND decision IS NULL
      AND terminal_reason IS NULL
      AND resolved_at_ms IS NULL
      AND resolver_kind IS NULL
      AND resolver_id IS NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'allowed'
      AND decision IN ('allow-once', 'allow-always')
      AND terminal_reason = 'user'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
    )
    OR (
      status = 'denied'
      AND decision = 'deny'
      AND terminal_reason IN ('user', 'malformed-verdict', 'no-route', 'storage-corrupt')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'expired'
      AND decision = 'deny'
      AND terminal_reason = 'timeout'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'cancelled'
      AND decision = 'deny'
      AND terminal_reason IN ('run-aborted', 'gateway-restart')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
  ),
  CHECK (
    (consumed_at_ms IS NULL AND consumed_by IS NULL)
    OR (
      status = 'allowed'
      AND decision = 'allow-once'
      AND consumed_at_ms IS NOT NULL
      AND consumed_by IS NOT NULL
    )
  )
);

CREATE INDEX idx_operator_approvals_status_expiry
  ON operator_approvals(status, expires_at_ms, approval_id);

CREATE UNIQUE INDEX idx_operator_approvals_resolution_ref
  ON operator_approvals(resolution_ref);

CREATE INDEX idx_operator_approvals_source_session_created
  ON operator_approvals(source_session_key, created_at_ms DESC, approval_id);

CREATE INDEX idx_operator_approvals_resolved
  ON operator_approvals(resolved_at_ms, approval_id)
  WHERE resolved_at_ms IS NOT NULL;

CREATE INDEX idx_operator_approvals_runtime_pending
  ON operator_approvals(runtime_epoch, approval_id)
  WHERE status = 'pending';
`;

function writeHistoricalCopiedStateFixture(stateDir: string): void {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(OPENCLAW_STATE_SCHEMA_SQL);
    database.exec(`
      DROP TABLE device_bootstrap_tokens;
      ${HISTORICAL_DEVICE_BOOTSTRAP_TOKENS_SQL}
      DROP TABLE operator_approvals;
      ${HISTORICAL_OPERATOR_APPROVALS_SQL}
      PRAGMA user_version = 2;
      INSERT INTO schema_meta (
        meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
      ) VALUES ('primary', 'global', 2, NULL, NULL, 0, 0);
      INSERT INTO device_bootstrap_tokens (token_key, token, ts, issued_at_ms)
      VALUES ('fixture-bootstrap', 'fixture-token', 1000, 1000);
    `);
  } finally {
    database.close();
  }
}

// Schema 15 and 16 deliberately share the physical layout. This fixture proves
// the fence/copy mechanics; the separate release lane supplies a real stable DB.
async function writeHeartbeatCopiedStateFixture(stateDir: string) {
  const sourcePath = path.join(stateDir, "heartbeat-source.sqlite");
  const candidatePath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
  const storeKey = path.join(stateDir, "cron", "jobs.json");
  const job = {
    id: "copied-monitor",
    name: "Copied monitor",
    agentId: "main",
    declarationKey: "heartbeat:main",
    enabled: false,
    createdAtMs: 10,
    updatedAtMs: 20,
    schedule: { kind: "every", everyMs: 900000, anchorMs: 37 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "heartbeat" },
  };
  const state = {
    nextRunAtMs: 123456,
    queuedAtMs: 123456,
    lastRunAtMs: 100000,
    lastRunStatus: "ok",
  };
  const writer = new DatabaseSync(sourcePath);
  try {
    writer.exec("PRAGMA journal_mode = WAL;");
    writer.exec(OPENCLAW_STATE_SCHEMA_SQL);
    writer.exec("PRAGMA user_version = 15;");
    writer
      .prepare(
        "INSERT INTO schema_meta (meta_key,role,schema_version,created_at,updated_at) VALUES ('primary','global',15,0,0)",
      )
      .run();
    writer
      .prepare(
        "INSERT INTO cron_jobs (store_key,job_id,declaration_key,name,enabled,agent_id,payload_kind,job_json,state_json,runtime_updated_at_ms,sort_order,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        storeKey,
        job.id,
        job.declarationKey,
        job.name,
        0,
        "main",
        "heartbeat",
        JSON.stringify(job),
        JSON.stringify(state),
        20,
        0,
        20,
      );
    writer
      .prepare(
        "INSERT INTO cron_job_scratch (store_key,job_id,content,revision,updated_at_ms) VALUES (?,?,?,?,?)",
      )
      .run(storeKey, job.id, "Keep these bytes.\r\n", 7, 20);
    writer
      .prepare(
        "INSERT INTO cron_run_receipts (receipt_id,store_key,job_id,config_revision,agent_id,status,owner_pid,started_at_ms,finished_at_ms) VALUES ('copied-run',?,?, 'old-revision','main','ok',1,10,20)",
      )
      .run(storeKey, job.id);
  } finally {
    writer.close(); // Stop the only old writer before taking a WAL-aware snapshot.
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, candidatePath);
  } finally {
    source.close();
  }
  return { sourcePath, candidatePath, storeKey, job, state };
}

describe("doctor copied-state migration", () => {
  it(
    "repairs the retained 2026.6.1-beta.1 shared state before gateway readiness",
    { timeout: 180_000 },
    async () => {
      const instance = await createOpenClawTestInstance({ name: "doctor-copied-state" });
      try {
        writeHistoricalCopiedStateFixture(instance.stateDir);

        const doctor = await instance.cli(
          ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
          { timeoutMs: 120_000 },
        );

        expect(doctor.code, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
        expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain(
          "Failed migrating shared state database schema",
        );
        await instance.startGateway();
      } finally {
        await instance.cleanup();
      }
    },
  );
  it(
    "cuts over copied schema-15 automations once and preserves a separate rollback snapshot",
    { timeout: 240_000 },
    async () => {
      const instance = await createOpenClawTestInstance({ name: "heartbeat-copied-state" });
      try {
        const fixture = await writeHeartbeatCopiedStateFixture(instance.stateDir);
        const config = JSON.parse(fs.readFileSync(instance.configPath, "utf8"));
        config.agents = {
          ...config.agents,
          defaults: { ...config.agents?.defaults, heartbeat: { every: "15m" } },
          entries: { main: {} },
        };
        config.cron = { store: fixture.storeKey };
        fs.writeFileSync(instance.configPath, JSON.stringify(config));
        const runDoctor = async () => {
          const result = await instance.cli(
            ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"],
            { timeoutMs: 120_000 },
          );
          expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
        };
        await runDoctor();
        let candidate = new DatabaseSync(fixture.candidatePath);
        try {
          expect(candidate.prepare("PRAGMA user_version").get()).toEqual({ user_version: 16 });
          const row = candidate
            .prepare("SELECT job_json,state_json FROM cron_jobs WHERE job_id = ?")
            .get(fixture.job.id) as { job_json: string; state_json: string };
          expect(JSON.parse(row.job_json)).toMatchObject({
            id: fixture.job.id,
            enabled: false,
            schedule: fixture.job.schedule,
            payload: { kind: "agentTurn" },
          });
          expect(JSON.parse(row.state_json)).toEqual(fixture.state);
          expect(
            candidate
              .prepare("SELECT content,revision FROM cron_job_scratch WHERE job_id = ?")
              .get(fixture.job.id),
          ).toEqual({ content: "Keep these bytes.\r\n", revision: 7 });
          expect(
            candidate
              .prepare("SELECT receipt_id FROM cron_run_receipts WHERE job_id = ?")
              .all(fixture.job.id),
          ).toEqual([{ receipt_id: "copied-run" }]);
          candidate.prepare("DELETE FROM cron_jobs WHERE job_id = ?").run(fixture.job.id);
          candidate.prepare("DELETE FROM cron_job_scratch WHERE job_id = ?").run(fixture.job.id);
        } finally {
          candidate.close();
        }
        await runDoctor();
        candidate = new DatabaseSync(fixture.candidatePath, { readOnly: true });
        try {
          expect(candidate.prepare("SELECT job_id FROM cron_jobs").all()).toEqual([]);
        } finally {
          candidate.close();
        }
        const restorePath = path.join(instance.stateDir, "rollback-separate.sqlite");
        const source = new DatabaseSync(fixture.sourcePath, { readOnly: true });
        try {
          await backup(source, restorePath);
        } finally {
          source.close();
        }
        const restored = new DatabaseSync(restorePath, { readOnly: true });
        try {
          expect(restored.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
          expect(
            restored
              .prepare("SELECT payload_kind FROM cron_jobs WHERE job_id = ?")
              .get(fixture.job.id),
          ).toEqual({ payload_kind: "heartbeat" });
        } finally {
          restored.close();
        }
      } finally {
        await instance.cleanup();
      }
    },
  );
});
