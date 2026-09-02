import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Top-level legacy config migration registry and rule inventory used by doctor.
import { LEGACY_CONFIG_MIGRATIONS_AUDIO } from "./legacy-config-migrations.audio.js";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";
import { LEGACY_CONFIG_MIGRATIONS_QQBOT } from "./legacy-config-migrations.qqbot.js";
import { LEGACY_CONFIG_MIGRATIONS_QUEUE } from "./legacy-config-migrations.queue.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";
import { LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH } from "./legacy-config-migrations.web-search.js";

const LEGACY_CONFIG_MIGRATION_SPECS = [
  ...LEGACY_CONFIG_MIGRATIONS_CHANNELS,
  ...LEGACY_CONFIG_MIGRATIONS_QQBOT,
  ...LEGACY_CONFIG_MIGRATIONS_AUDIO,
  ...LEGACY_CONFIG_MIGRATIONS_QUEUE,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME,
  ...LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH,
];

/** Ordered legacy migrations without their preview-only rule metadata. */
export const LEGACY_CONFIG_MIGRATIONS = LEGACY_CONFIG_MIGRATION_SPECS.map(
  ({ legacyRules: _legacyRules, ...migration }) => migration,
);

/** Aggregated legacy config rules used for doctor preview issue detection. */
export const LEGACY_CONFIG_MIGRATION_RULES = LEGACY_CONFIG_MIGRATION_SPECS.flatMap(
  (migration) => migration.legacyRules ?? [],
);

// Detection only: deleting these inputs requires Doctor's durable automation cutover.
LEGACY_CONFIG_MIGRATION_RULES.push(
  {
    path: ["agents", "defaults", "heartbeat"],
    message:
      "Heartbeat configuration retired; run openclaw doctor --fix to preserve it as an editable automation.",
  },
  {
    path: ["agents", "entries"],
    match: (value) =>
      isRecord(value) &&
      Object.values(value).some((entry) => isRecord(entry) && entry.heartbeat !== undefined),
    message: "Per-agent heartbeat configuration requires openclaw doctor --fix before startup.",
  },
  {
    path: ["agents", "list"],
    match: (value) =>
      Array.isArray(value) &&
      value.some((entry) => isRecord(entry) && entry.heartbeat !== undefined),
    message: "Per-agent heartbeat configuration requires openclaw doctor --fix before startup.",
  },
  {
    path: ["channels"],
    match: (value) =>
      isRecord(value) &&
      Object.entries(value).some(([id, channel]) => {
        const hasVisibility = (owner: unknown, allowEmpty = false): boolean =>
          isRecord(owner) &&
          (owner.heartbeatVisibility !== undefined ||
            (isRecord(owner.heartbeat) &&
              (allowEmpty || Object.keys(owner.heartbeat).length > 0) &&
              Object.keys(owner.heartbeat).every((key) =>
                ["showOk", "showAlerts", "useIndicator"].includes(key),
              )));
        return (
          hasVisibility(channel, id === "defaults") ||
          (isRecord(channel) &&
            isRecord(channel.accounts) &&
            Object.values(channel.accounts).some((account) => hasVisibility(account)))
        );
      }),
    message:
      "Channel heartbeat visibility requires openclaw doctor --fix before startup; transport heartbeat settings are not retired.",
  },
);
