// Cron store selection preserves the retired configured partition through shared SQLite state.
import type { DatabaseSync } from "node:sqlite";
import {
  readConfigMachineState,
  readConfigMachineStateInDatabase,
} from "../../state/config-machine-state.js";

export function readCronStoreStatePath(
  env: NodeJS.ProcessEnv = process.env,
  database?: DatabaseSync,
): string | undefined {
  const value = database
    ? readConfigMachineStateInDatabase(database, "cron.store")
    : readConfigMachineState<unknown>("cron.store", { env });
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
