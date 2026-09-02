import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { provisionDefaultProactiveJob } from "./default-proactive-job.js";
import { readDefaultProactiveJobReceiptInDatabase } from "./proactive-job-receipt.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePathFromConfig,
} from "./store.js";
import { cronStoreKey } from "./store/key.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);

describe("proactive provisioning receipt boundary", () => {
  it.each([
    null,
    {},
    { jobId: "deleted", provisionedAtMs: 1, phase: "unknown" },
    { jobId: "deleted", provisionedAtMs: "1", phase: "complete" },
    { jobId: "deleted", provisionedAtMs: 1, phase: "pending", convertedJobIds: [42] },
  ])("rejects corrupt receipt %j without provisioning a replacement", async (receipt) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("proactive-receipt-") };
    const config: OpenClawConfig = { agents: { entries: { main: {} } } };
    const storePath = resolveCronJobsStorePathFromConfig(config, env);
    writeConfigMachineState(`automation-default:${cronStoreKey(storePath)}:main`, receipt, { env });
    const { db } = openOpenClawStateDatabase({ env });
    expect(() => readDefaultProactiveJobReceiptInDatabase(db, storePath, "main")).toThrow(
      /Invalid.*receipt.*known-good backup or manual repair.*Doctor cannot safely reconstruct it.*No automation was recreated/,
    );
    expect(() => provisionDefaultProactiveJob(config, "main", { env })).toThrow(
      /Invalid.*receipt.*known-good backup or manual repair.*Doctor cannot safely reconstruct it.*No automation was recreated/,
    );
    expect((await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env)).store.jobs).toEqual([]);
  });
});
