import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultProactiveJob } from "../cron/default-proactive-job.js";
import {
  subscribeCronJobsStoreMutations,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import { callGateway } from "./call.js";
import { publishProvisionedCronJob } from "./cron-lifecycle-publication.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./call.js", () => ({
  callGateway: vi.fn(),
  isGatewayCredentialsRequiredError: (error: unknown) =>
    error instanceof Error && error.name === "GatewayCredentialsRequiredError",
}));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn }) }));
afterEach(() => vi.clearAllMocks());

describe("provisioned cron publication", () => {
  it("uses the existing read API, without replaying a declaration or mutation", async () => {
    const job = createDefaultProactiveJob({}, "main", Date.now());
    vi.mocked(callGateway).mockResolvedValueOnce(job);
    await publishProvisionedCronJob({}, job);
    expect(callGateway).toHaveBeenCalledExactlyOnceWith({
      method: "cron.get",
      params: { id: job.id },
      timeoutMs: 3000,
      config: {},
    });
  });
  it("uses the local commit subscription without connecting back to its own Gateway", async () => {
    const unsubscribe = subscribeCronJobsStoreMutations(
      resolveCronJobsStorePathFromConfig({}),
      () => {},
    );
    try {
      await publishProvisionedCronJob({}, createDefaultProactiveJob({}, "main", Date.now()));
      expect(callGateway).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
  it("reports an offline acknowledgement, but never hides deletion or authorization errors", async () => {
    const job = createDefaultProactiveJob({}, "main", Date.now());
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway timeout after 3000ms"));
    await publishProvisionedCronJob({}, job);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Automation ${job.id} is saved`));
    const missingCredentials = new Error("Pair this new installation before querying the Gateway.");
    missingCredentials.name = "GatewayCredentialsRequiredError";
    vi.mocked(callGateway).mockRejectedValueOnce(missingCredentials);
    await publishProvisionedCronJob({}, job);
    expect(warn).toHaveBeenCalledTimes(2);
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("cron job not found"));
    await expect(publishProvisionedCronJob({}, job)).rejects.toThrow("cron job not found");
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("unauthorized"));
    await expect(publishProvisionedCronJob({}, job)).rejects.toThrow("unauthorized");
  });
});
