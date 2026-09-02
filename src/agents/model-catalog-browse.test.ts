import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  loadPreparedModelCatalogSnapshotForBrowse,
} from "./model-catalog-browse.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

const readOnlyCatalog: ModelCatalogSnapshot = {
  entries: [{ id: "gpt-readonly", name: "GPT Readonly", provider: "openai" }],
  routeVariants: [{ id: "gpt-readonly", name: "GPT Readonly", provider: "openai" }],
};
const fullCatalog: ModelCatalogSnapshot = {
  entries: [{ id: "gpt-full", name: "GPT Full", provider: "openai" }],
  routeVariants: [{ id: "gpt-full", name: "GPT Full", provider: "openai" }],
};

function catalogLoader() {
  return vi.fn(async ({ readOnly }: { readOnly: boolean }) =>
    readOnly ? readOnlyCatalog : fullCatalog,
  );
}

describe("loadPreparedModelCatalogSnapshotForBrowse", () => {
  it("uses the read-only catalog for ordinary browse views", async () => {
    const loadCatalog = catalogLoader();

    await expect(loadPreparedModelCatalogSnapshotForBrowse({ loadCatalog })).resolves.toBe(
      readOnlyCatalog,
    );
    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({ view: "provider-config", loadCatalog }),
    ).resolves.toBe(readOnlyCatalog);

    expect(loadCatalog).toHaveBeenCalledTimes(2);
    expect(loadCatalog).toHaveBeenNthCalledWith(1, { readOnly: true });
    expect(loadCatalog).toHaveBeenNthCalledWith(2, { readOnly: true });
  });

  it("uses full discovery only for all and explicit refresh", async () => {
    const loadCatalog = catalogLoader();

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({ view: "all", loadCatalog }),
    ).resolves.toBe(fullCatalog);
    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        view: "configured",
        refresh: true,
        loadCatalog,
      }),
    ).resolves.toBe(fullCatalog);

    expect(loadCatalog).toHaveBeenNthCalledWith(1, { readOnly: false });
    expect(loadCatalog).toHaveBeenNthCalledWith(2, { readOnly: false, refresh: true });
  });

  it("keeps prepared-only all views read-only", async () => {
    const loadCatalog = catalogLoader();

    await expect(
      loadPreparedModelCatalogSnapshotForBrowse({
        view: "all",
        preparedOnly: true,
        loadCatalog,
      }),
    ).resolves.toBe(readOnlyCatalog);

    expect(loadCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
  });

  it("builds provider-config inventory independently of picker allowlists", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/allowlisted": {},
          },
        },
      },
      models: {
        providers: {
          openai: {
            models: [
              { id: "two", name: "Two" },
              { id: "one", name: "One" },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(buildProviderConfigModelCatalogForBrowse({ cfg })).toMatchObject([
      { provider: "openai", id: "one", name: "One" },
      { provider: "openai", id: "two", name: "Two" },
    ]);
  });
});
