/** Legacy outcome transfer used only by Doctor before canonical-key cutover. */
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

export function copyRetiredSessionOutcomesForDoctor(
  source: OpenClawAgentDatabase,
  destination: OpenClawAgentDatabase,
  keys: readonly string[],
  canonicalKey: string,
): void {
  if (keys.length === 0) {
    return;
  }
  const sourceDb = getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(source.db);
  const destinationDb = getNodeSqliteKysely<Pick<DB, "heartbeat_outcomes">>(destination.db);
  const sourceKeyReferences = new Set(keys.flatMap((key) => [key, key.trim()]));
  if (
    tableExists(source.db, "heartbeat_outcomes") &&
    tableExists(destination.db, "heartbeat_outcomes")
  ) {
    for (const heartbeat of executeSqliteQuerySync(
      source.db,
      sourceDb.selectFrom("heartbeat_outcomes").selectAll().where("session_key", "in", keys),
    ).rows) {
      executeSqliteQuerySync(
        destination.db,
        destinationDb
          .insertInto("heartbeat_outcomes")
          .values({
            ...heartbeat,
            session_key: canonicalKey,
            run_session_key: sourceKeyReferences.has(heartbeat.run_session_key)
              ? canonicalKey
              : heartbeat.run_session_key,
          })
          .onConflict((conflict) =>
            conflict
              .column("session_key")
              .doUpdateSet({
                ...heartbeat,
                session_key: canonicalKey,
                run_session_key: sourceKeyReferences.has(heartbeat.run_session_key)
                  ? canonicalKey
                  : heartbeat.run_session_key,
              })
              .where((eb) =>
                eb.or([
                  eb("updated_at", "<", heartbeat.updated_at),
                  eb.and([
                    eb("updated_at", "=", heartbeat.updated_at),
                    eb("occurred_at", "<", heartbeat.occurred_at),
                  ]),
                ]),
              ),
          ),
      );
    }
  }
}
