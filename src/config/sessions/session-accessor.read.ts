/** Storage-neutral exact read API; admission need not import mutation or provider owners. */
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope, ExactSessionEntry } from "./session-accessor.types.js";

/** Exact persisted-key probe on the read-only handle, for per-row hot paths. */
export function loadExactSessionEntryReadOnly(
  scope: SessionAccessScope,
): ExactSessionEntry | undefined {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readExactSessionEntryRowValidated(database, sessionKey)?.entry,
    toDatabaseOptions(resolved),
  );
  return result.found && result.value
    ? {
        sessionKey,
        entry: result.value,
      }
    : undefined;
}
