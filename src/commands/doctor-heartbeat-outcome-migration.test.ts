import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import * as runtimeContext from "../sessions/runtime-context.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { migrateHeartbeatOutcomes } from "./doctor-heartbeat-outcome-migration.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-outcomes-"));
  roots.push(root);
  const env = { ...process.env, HOME: root, OPENCLAW_STATE_DIR: root };
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const now = Date.now();
  const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env });
  const scope = { agentId: "main", storePath, env, sessionKey: "agent:main:main" };
  await replaceSessionEntry(scope, {
    sessionId: "original",
    lifecycleRevision: "generation-1",
    updatedAt: now,
    sessionStartedAt: now - 2000,
  });
  const options = toDatabaseOptions(resolveSqliteScope(scope));
  const database = () => openOpenClawAgentDatabase(options).db;
  const row = {
    session_key: scope.sessionKey,
    run_session_key: scope.sessionKey,
    outcome: "progress",
    summary: "The synthetic backup finished.",
    response_reason: null,
    priority: null,
    next_check: null,
    task_names_json: null,
    wake_source: null,
    wake_reason: null,
    occurred_at: now - 1000,
    context_run_id: null,
    context_claimed_at: null,
    updated_at: now,
  };
  executeSqliteQuerySync(
    database(),
    getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(database())
      .insertInto("heartbeat_outcomes")
      .values(row),
  );
  const pending = () =>
    executeSqliteQuerySync(
      database(),
      getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(database())
        .selectFrom("heartbeat_outcomes")
        .selectAll(),
    ).rows;
  const update = (values: Partial<typeof row>) =>
    executeSqliteQuerySync(
      database(),
      getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(database())
        .updateTable("heartbeat_outcomes")
        .set(values)
        .where("session_key", "=", scope.sessionKey),
    );
  const events = () => loadTranscriptEventsSync({ ...scope, sessionId: "original" });
  return { cfg, env, scope, row, pending, update, events, now };
}

describe("Doctor pending heartbeat context", () => {
  it("replays an interrupted transfer once and consumes only its original row across reopen", async () => {
    const f = await fixture();
    const append = runtimeContext.appendSessionRuntimeContext;
    const crash = vi
      .spyOn(runtimeContext, "appendSessionRuntimeContext")
      .mockImplementationOnce(async (params) => {
        await append(params);
        throw new Error("interrupted after transcript commit");
      });
    await expect(migrateHeartbeatOutcomes(f.cfg, f.env)).rejects.toThrow(
      "interrupted after transcript commit",
    );
    expect(f.pending()).toEqual([f.row]);
    const committed = f.events();
    expect(JSON.stringify(committed)).toContain(f.row.summary);
    crash.mockRestore();
    closeOpenClawAgentDatabasesForTest();
    await migrateHeartbeatOutcomes(f.cfg, f.env);
    expect(f.pending()).toEqual([]);
    expect(f.events()).toEqual(committed);
    expect(loadSessionEntryReadOnly(f.scope)?.updatedAt).toBe(f.now);
    await migrateHeartbeatOutcomes(f.cfg, f.env);
    expect(f.events()).toEqual(committed);
  });

  it.each(["before-append", "after-append"] as const)(
    "retains a newer source row arriving %s",
    async (when) => {
      const f = await fixture();
      const append = runtimeContext.appendSessionRuntimeContext;
      vi.spyOn(runtimeContext, "appendSessionRuntimeContext").mockImplementationOnce(
        async (params) => {
          if (when === "after-append") {
            await append(params);
          }
          f.update({ summary: "Newer authoritative outcome", updated_at: f.now + 1 });
          if (when === "before-append") {
            await append(params);
          }
        },
      );
      await expect(migrateHeartbeatOutcomes(f.cfg, f.env)).rejects.toThrow(
        "changed during cutover",
      );
      expect(f.pending()).toEqual([
        { ...f.row, summary: "Newer authoritative outcome", updated_at: f.now + 1 },
      ]);
      if (when === "before-append") {
        expect(JSON.stringify(f.events())).not.toContain(f.row.summary);
      }
    },
  );

  it("does not deliver into a replaced session generation", async () => {
    const f = await fixture();
    const append = runtimeContext.appendSessionRuntimeContext;
    vi.spyOn(runtimeContext, "appendSessionRuntimeContext").mockImplementationOnce(
      async (params) => {
        await replaceSessionEntry(f.scope, {
          sessionId: "replacement",
          lifecycleRevision: "generation-2",
          updatedAt: f.now,
        });
        await append(params);
      },
    );
    await expect(migrateHeartbeatOutcomes(f.cfg, f.env)).rejects.toThrow("Session changed");
    expect(f.pending()).toEqual([f.row]);
    expect(
      JSON.stringify(loadTranscriptEventsSync({ ...f.scope, sessionId: "replacement" })),
    ).not.toContain(f.row.summary);
  });

  it.each(["before-generation", "expired-session"] as const)(
    "does not promote %s into permanent context",
    async (condition) => {
      const f = await fixture();
      if (condition === "before-generation") {
        f.update({ occurred_at: f.now - 3000 });
      }
      if (condition === "expired-session") {
        f.cfg.session = { reset: { mode: "idle", idleMinutes: 1 } };
        await replaceSessionEntry(f.scope, {
          sessionId: "original",
          updatedAt: f.now - 120000,
          sessionStartedAt: f.now - 120000,
        });
      }
      await migrateHeartbeatOutcomes(f.cfg, f.env);
      expect(JSON.stringify(f.events())).not.toContain(f.row.summary);
      expect(f.pending()).toHaveLength(1);
    },
  );
});
