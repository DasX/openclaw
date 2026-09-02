// Active-hours evidence runs ordinary cron admission and persisted policy updates.
// Natural timer cadence is covered by the cron service integration tests.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CronService } from "../../../../src/cron/service.js";
import { saveCronStore } from "../../../../src/cron/store.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

type HeartbeatRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
};

type SchedulerObservation = {
  at: string;
  outcome: "active-fire" | "quiet-hours-skip";
};

function parseOptions(argv: string[], repoRoot = process.cwd()): HeartbeatRuntimeOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "heartbeat-active-hours");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      artifactBase = path.resolve(repoRoot, argv[++index] ?? "");
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { artifactBase, repoRoot };
}

function createWriter(options: HeartbeatRuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "heartbeat-active-hours.log",
    primaryModel: "cron/scheduler",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: "heartbeat-active-hours",
      title: "Ordinary automation active-hours policy",
      sourcePath: "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
      docsRefs: ["docs/automation/cron-jobs.md"],
      codeRefs: [
        "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
        "src/cron/service/timer-execution.ts",
        "src/cron/active-hours.ts",
      ],
    },
  });
}

export async function runHeartbeatActiveHoursRuntime(options: HeartbeatRuntimeOptions) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  const observations: SchedulerObservation[] = [];
  const storePath = path.join(options.artifactBase, "state", "cron", "jobs.json");
  const log = (entry: unknown, message?: string) => {
    writer.appendLog(`${message ?? JSON.stringify(entry)}\n`);
  };
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    log: { debug: log, info: log, warn: log, error: log },
    enqueueSystemEvent: () => {
      throw new Error("Active-hours evidence must use session execution");
    },
    runIsolatedAgentJob: async () => {
      throw new Error("Active-hours evidence must use its original session");
    },
    runSessionEvent: async () => {
      observations.push({ at: new Date().toISOString(), outcome: "active-fire" });
      return { status: "ok", executionStarted: true };
    },
  });
  try {
    const job = await cron.add({
      name: "Active-hours evidence",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      activeHours: { start: "00:00", end: "24:00", timezone: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Check the active-hours policy" },
    });
    for (const quiet of [false, true, false]) {
      await cron.update(job.id, {
        activeHours: { start: "00:00", end: quiet ? "00:00" : "24:00", timezone: "UTC" },
      });
      const before = observations.length;
      let settled = false;
      const result = await cron.run(job.id, "force", {
        onSettledResult: (outcome) => {
          if (outcome.status !== (quiet ? "skipped" : "ok")) {
            throw new Error(`Unexpected active-hours result: ${outcome.status}`);
          }
          if (quiet) {
            if (observations.length !== before) {
              throw new Error("Quiet-hours policy must not start session execution");
            }
            observations.push({ at: new Date().toISOString(), outcome: "quiet-hours-skip" });
          }
          settled = true;
        },
      });
      if (!result.ok || !("ran" in result) || !result.ran || !settled) {
        throw new Error("Active-hours occurrence did not settle");
      }
    }

    const summaryPath = path.join(options.artifactBase, "heartbeat-active-hours-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify({ observations }, null, 2)}\n`, "utf8");
    return await writer.write({
      artifacts: [{ kind: "summary", filePath: summaryPath }],
      details: "Observed active fire, quiet-hours skip, and active-hours reload fire",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`heartbeat-active-hours: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    cron.stop();
    await saveCronStore(storePath, { version: 1, jobs: [] });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runHeartbeatActiveHoursRuntime(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      const status = evidence.entries[0]?.result.status;
      process.stdout.write(`heartbeat-active-hours: ${status}\n`);
      process.exitCode = status === "pass" ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`heartbeat-active-hours: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
