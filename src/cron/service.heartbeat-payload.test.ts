import { describe, expect, it } from "vitest";
import {
  createCronStoreHarness,
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
  installCronTestHooks,
} from "./service.test-harness.js";
const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger });

describe("report-only legacy heartbeat jobs", () => {
  it("refuses authoring even from the retired system owner", async () => {
    const { storePath } = await makeStorePath();
    const { cron, runSessionEvent } = createStartedCronServiceWithFinishedBarrier({
      storePath,
      logger,
    });
    try {
      await expect(
        cron.add(
          {
            name: "legacy",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "main",
            wakeMode: "now",
            payload: { kind: "heartbeat" },
          },
          { systemOwned: true },
        ),
      ).rejects.toThrow("report-only");
      expect(runSessionEvent).not.toHaveBeenCalled();
    } finally {
      cron.stop();
    }
  });
});
