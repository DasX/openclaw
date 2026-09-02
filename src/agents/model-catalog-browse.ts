/**
 * Loads model catalog views for browse/search UI surfaces.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";

/** Visible model subset requested by model browse callers. */
export type ModelCatalogBrowseView = "default" | "configured" | "provider-config" | "all";

/** Source-authored provider rows for inventory UIs, independent of picker allowlists. */
export function buildProviderConfigModelCatalogForBrowse(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
}): ModelCatalogEntry[] {
  return buildConfiguredModelCatalog(params).toSorted(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
}

/** Loads an explicit logical/physical catalog snapshot for route-aware browse surfaces. */
export async function loadPreparedModelCatalogSnapshotForBrowse(params: {
  view?: ModelCatalogBrowseView;
  preparedOnly?: boolean;
  refresh?: boolean;
  loadCatalog: (params: { readOnly: boolean; refresh?: boolean }) => Promise<ModelCatalogSnapshot>;
}): Promise<ModelCatalogSnapshot> {
  const view = params.view ?? "default";
  const requiresFullDiscovery =
    params.preparedOnly !== true && (params.refresh === true || view === "all");
  return await params.loadCatalog({
    readOnly: !requiresFullDiscovery,
    ...(requiresFullDiscovery && params.refresh ? { refresh: true } : {}),
  });
}
