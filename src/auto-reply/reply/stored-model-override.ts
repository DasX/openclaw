// Normalizes stored reply model references.
import { resolveCliRuntimeCanonicalProvider } from "../../agents/cli-backends.js";
import { normalizeModelRef } from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeModelNormalization } from "./model-runtime-normalization.js";

/** Normalizes a stored model ref, resolving runtime aliases only for CLI-bound sessions. */
export function normalizeStoredRuntimeModelRef(
  provider: string,
  model: string,
  cfg?: OpenClawConfig,
  sessionEntry?: SessionEntry,
  normalization: RuntimeModelNormalization = RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
) {
  const normalized = normalizeModelRef(provider, model, normalization);
  const hasCliSessionBinding =
    sessionEntry?.cliSessionBindings?.[normalized.provider] !== undefined;
  const canonicalProvider =
    cfg && hasCliSessionBinding
      ? resolveCliRuntimeCanonicalProvider({
          runtime: normalized.provider,
          config: cfg,
          includeSetupRegistry: true,
        })
      : undefined;
  return canonicalProvider ? { ...normalized, provider: canonicalProvider } : normalized;
}
