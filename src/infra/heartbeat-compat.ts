/** Deprecated v4 controls. Ordinary automation receipts are the only ownership source. */
import type { DatabaseSync } from "node:sqlite";
import { listAgentIds } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";

export function getLegacyHeartbeatJobIds(cfg: OpenClawConfig): string[] {
  return getLegacyHeartbeatJobIdsInDatabase(cfg, openOpenClawStateDatabase().db);
}

/** Read identity from the caller's snapshot; never reopen shared state per agent. */
export function getLegacyHeartbeatJobIdsInDatabase(
  cfg: OpenClawConfig,
  db: DatabaseSync,
): string[] {
  const storePath = resolveCronJobsStorePathFromConfig(cfg, process.env, db);
  return listAgentIds(cfg).flatMap((agentId) => {
    const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
    return receipt?.phase === "complete"
      ? [receipt.jobId].concat(receipt.convertedJobIds ?? [])
      : [];
  });
}

export async function setLegacyHeartbeatsEnabled(
  cfg: OpenClawConfig,
  cron: CronServiceContract,
  enabled: boolean,
): Promise<void> {
  const ids = new Set(getLegacyHeartbeatJobIds(cfg));
  const jobs = (await cron.list({ includeDisabled: true })).filter((job) => ids.has(job.id));
  if (!jobs.length) {
    throw new Error(
      "No converted/default proactive automation exists. Run openclaw doctor --fix or manage ordinary automations; deleted jobs are not recreated.",
    );
  }
  for (const job of jobs) {
    await cron.update(job.id, { enabled });
  }
}

/** Stable hook boundary: converted/default jobs only, never unrelated cron turns. */
export async function applyLegacyHeartbeatPromptContribution(params: {
  cfg: OpenClawConfig;
  jobId: string;
  name: string;
  agentId: string;
  sessionKey: string;
  prompt: string;
  assertCurrent: () => void;
}): Promise<string> {
  if (!getLegacyHeartbeatJobIds(params.cfg).includes(params.jobId)) {
    return params.prompt;
  }
  const { getGlobalHookRunner } = await import("../plugins/hook-runner-global.js");
  params.assertCurrent();
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("heartbeat_prompt_contribution")) {
    return params.prompt;
  }
  const contribution = await runner.runHeartbeatPromptContribution(
    { agentId: params.agentId, sessionKey: params.sessionKey, heartbeatName: params.name },
    { agentId: params.agentId, sessionKey: params.sessionKey, trigger: "heartbeat" },
  );
  params.assertCurrent();
  const { sliceToolResultTextToBudget } =
    await import("../agents/embedded-agent-runner/tool-result-text-budget.js");
  params.assertCurrent();
  return [
    contribution?.prependContext && sliceToolResultTextToBudget(contribution.prependContext, 1000),
    params.prompt,
    contribution?.appendContext && sliceToolResultTextToBudget(contribution.appendContext, 1000),
  ]
    .filter(Boolean)
    .join("\n\n");
}
