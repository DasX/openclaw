import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOomScoreAdjustedSpawn } from "../process/linux-oom-score.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  ensureProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";

describe("provider local service Linux OOM scoring", () => {
  afterEach(async () => {
    await stopManagedProviderLocalServices();
  });

  it.runIf(process.platform === "linux")(
    "raises managed local services' OOM score",
    async ({ skip }) => {
      let hostOomScore: number;
      try {
        hostOomScore = Number.parseInt(
          (await fs.readFile("/proc/self/oom_score_adj", "utf8")).trim(),
          10,
        );
      } catch {
        skip();
        return;
      }
      if (!Number.isFinite(hostOomScore) || hostOomScore >= 1000) {
        skip();
        return;
      }

      const preparedSpawn = prepareOomScoreAdjustedSpawn(process.execPath, [], {
        env: process.env,
      });
      if (!preparedSpawn.wrapped) {
        skip();
        return;
      }

      const port = await getFreePort();
      const healthUrl = `http://127.0.0.1:${port}/v1/models`;
      const lease = await ensureProviderLocalService({
        providerId: "local-oom-score",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        service: {
          command: process.execPath,
          args: [
            "-e",
            `const fs=require("node:fs");const http=require("node:http");const server=http.createServer((req,res)=>res.end(fs.readFileSync("/proc/self/oom_score_adj","utf8").trim())).listen(${port},"127.0.0.1");process.on("SIGTERM",()=>server.close(()=>process.exit(0)));`,
          ],
          healthUrl,
          readyTimeoutMs: 5_000,
          idleStopMs: 1,
        },
      });
      if (!lease) {
        throw new Error("Expected provider local service lease");
      }
      expect(await (await fetch(healthUrl)).text()).toBe("1000");
      lease.release();
      await expect
        .poll(
          async () => {
            try {
              await fetch(healthUrl);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 2_000, interval: 50 },
        )
        .toBe(true);
    },
  );
});
