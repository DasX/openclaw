/** Acknowledge setup's local SQLite adoption through the existing cron read API. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasCronJobsStoreMutationSubscriber,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { callGateway, isGatewayCredentialsRequiredError } from "./call.js";
import { isGatewayRpcUnavailableError } from "./transport-error.js";

export async function publishProvisionedCronJob(
  cfg: OpenClawConfig,
  job: CronJob | undefined,
): Promise<void> {
  if (!job || hasCronJobsStoreMutationSubscriber(resolveCronJobsStorePathFromConfig(cfg))) {
    return;
  }
  // Local rows cannot be acknowledged by a different host's Gateway.
  if (cfg.gateway?.mode === "remote") {
    return;
  }
  try {
    const current = await callGateway<{ id: string }>({
      method: "cron.get",
      params: { id: job.id },
      timeoutMs: 3000,
      config: cfg,
    });
    if (current.id !== job.id) {
      throw new Error(`Gateway did not acknowledge automation ${job.id}.`);
    }
  } catch (error) {
    if (!isGatewayRpcUnavailableError(error) && !isGatewayCredentialsRequiredError(error)) {
      throw error;
    }
    // Setup is also an offline workflow. Retain its atomic job/receipt and make
    // the unacknowledged scheduling state explicit; normal start loads the row.
    createSubsystemLogger("cron").warn(
      `Automation ${job.id} is saved; Gateway adoption was not acknowledged. Start the Gateway or inspect cron list when it is reachable.`,
    );
  }
}
