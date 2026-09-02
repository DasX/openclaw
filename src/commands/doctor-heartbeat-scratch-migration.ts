/** Doctor-owned migration from workspace HEARTBEAT.md files into cron job scratch. */
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder, isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/default-proactive-job.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import {
  hashCronScratchSource,
  readCronJobScratchState,
  writeCronJobScratch,
} from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  projectCronJobThroughStorageCodec,
} from "../cron/store/row-codec.js";
import type { CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { isPathInside } from "../infra/path-guards.js";
import { readRegularFile } from "../infra/regular-file.js";
import { escapeRegExp } from "../shared/regexp.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { shortenHomePath } from "../utils.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import { resolveHeartbeatAgents } from "./doctor-heartbeat-legacy.js";

const HEARTBEAT_SCRATCH_MIGRATION_CHECK_ID = "core/doctor/heartbeat-scratch-migration";
const LEGACY_HEARTBEAT_FILENAME = "HEARTBEAT.md";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type HeartbeatScratchMigrationResult = {
  changes: string[];
  warnings: string[];
};

type HeartbeatSource = {
  path: string;
  /** Canonical parent directory + basename: the identity of the removable entry. */
  entryKey: string;
  content: string;
  sha256: string;
};

async function readHeartbeatSource(
  cfg: OpenClawConfig,
  agentId: string,
  options?: { recoverClaims?: boolean; env?: NodeJS.ProcessEnv },
): Promise<HeartbeatSource | undefined> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId, options?.env);
  const heartbeatPath = path.join(workspaceDir, LEGACY_HEARTBEAT_FILENAME);
  let sourceStat;
  try {
    sourceStat = await fs.lstat(heartbeatPath);
    // A claim sibling next to an existing canonical file means an interrupted
    // migration raced a recreation. Neither copy is provably authoritative, so
    // stop instead of migrating one and silently resurrecting the other later.
    const orphanClaim = await findStaleHeartbeatClaim(heartbeatPath);
    if (orphanClaim) {
      throw new Error(
        `both ${heartbeatPath} and an interrupted migration claim at ${orphanClaim} exist; reconcile them manually before rerunning doctor`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Crash recovery: a killed run can leave the only copy at a claim path
    // after the rename but before scratch release. Surface it here so both
    // findings and repair see the interrupted migration instead of "no file".
    const staleClaim = await findStaleHeartbeatClaim(heartbeatPath);
    if (!staleClaim) {
      return undefined;
    }
    if (!options?.recoverClaims) {
      throw new Error(
        `an interrupted migration claim exists at ${staleClaim}; run openclaw doctor --fix to restore it`,
        { cause: error },
      );
    }
    await restoreClaimNoClobber(staleClaim, heartbeatPath);
    sourceStat = await fs.lstat(heartbeatPath);
  }
  if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
    throw new Error("HEARTBEAT.md must be a regular file or contained symlink");
  }
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw new Error("HEARTBEAT.md has multiple hard links; refusing automatic removal");
  }

  const workspaceRealPath = await fs.realpath(workspaceDir);
  const sourceRealPath = await fs.realpath(heartbeatPath);
  if (sourceRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, sourceRealPath)) {
    throw new Error("HEARTBEAT.md symlink target escapes the agent workspace");
  }
  const file = await readRegularFile({
    filePath: sourceRealPath,
    maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
  });
  let content: string;
  try {
    content = utf8Decoder.decode(file.buffer);
  } catch {
    throw new Error("HEARTBEAT.md is not valid UTF-8");
  }
  return {
    path: heartbeatPath,
    entryKey: path.join(workspaceRealPath, LEGACY_HEARTBEAT_FILENAME),
    content,
    sha256: hashCronScratchSource(content),
  };
}

function archivePathForSource(agentId: string, sha256: string, env: NodeJS.ProcessEnv): string {
  const safeAgentId = agentId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(
    resolveStateDir(env),
    "backups",
    "heartbeat-migration",
    `${safeAgentId}-${sha256}.md`,
  );
}

type HeartbeatSourceClaim = {
  claimPath: string;
  restore(cause: unknown): Promise<void>;
  retain(): Promise<void>;
  release(params: { archivePath: string; verifyDestination: () => void }): Promise<void>;
};

const HEARTBEAT_CLAIM_INFIX = ".doctor-importing-";
const HEARTBEAT_CLAIM_CHANGED_ERROR = "HeartbeatClaimChangedError";

/** Interrupted-claim sibling for a missing canonical heartbeat path. */
async function findStaleHeartbeatClaim(heartbeatPath: string): Promise<string | undefined> {
  const dir = path.dirname(heartbeatPath);
  // Match the exact generated claim shape so an unrelated user file that
  // merely shares the prefix is never consumed by recovery.
  const claimPattern = new RegExp(
    `^${escapeRegExp(path.basename(heartbeatPath))}${escapeRegExp(HEARTBEAT_CLAIM_INFIX)}\\d+-[0-9a-f]{12}$`,
  );
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const claims = entries.filter((entry) => claimPattern.test(entry));
  if (claims.length > 1) {
    throw new Error(
      `multiple interrupted migration claims exist for ${heartbeatPath}; remove or restore the stale .doctor-importing-* files manually`,
    );
  }
  const claim = claims[0];
  if (!claim) {
    return undefined;
  }
  // The claim name embeds the owning PID. A live owner means another doctor
  // run is mid-migration; stealing its claim could delete both copies.
  const ownerPid = Number(
    claim
      .slice(claim.lastIndexOf(HEARTBEAT_CLAIM_INFIX) + HEARTBEAT_CLAIM_INFIX.length)
      .split("-")[0],
  );
  if (Number.isSafeInteger(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
    throw new Error(
      `a migration claim for ${heartbeatPath} is held by running process ${ownerPid}; wait for that doctor run to finish`,
    );
  }
  return path.join(dir, claim);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Restore a claim without clobbering: `link` fails with EEXIST when another
 * process recreated the destination while we held the claim, so both files
 * survive (the recreation in place, the claimed original at a conflict path).
 */
async function restoreClaimNoClobber(claimPath: string, destinationPath: string): Promise<void> {
  try {
    await fs.link(claimPath, destinationPath);
    await fs.unlink(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const conflictPath = `${claimPath}.conflict-${Date.now()}`;
    await fs.rename(claimPath, conflictPath);
    throw new Error(
      `HEARTBEAT.md was recreated during migration; the claimed original is preserved at ${conflictPath}`,
      { cause: error },
    );
  }
}

/**
 * Move the source aside and prove the claimed bytes still match what was read.
 * The claim happens before any scratch write so a concurrent edit can never
 * leave stale content committed while the replacement file is restored.
 */
async function claimHeartbeatSource(source: HeartbeatSource): Promise<HeartbeatSourceClaim> {
  const claimPath = `${source.path}${HEARTBEAT_CLAIM_INFIX}${process.pid}-${source.sha256.slice(0, 12)}`;
  await fs.rename(source.path, claimPath);
  const restore = async (cause: unknown) => {
    await restoreClaimNoClobber(claimPath, source.path).catch((restoreError: unknown) => {
      throw restoreError instanceof Error && restoreError.message.includes("preserved at")
        ? restoreError
        : new Error(`HEARTBEAT.md migration claim could not be restored from ${claimPath}`, {
            cause: cause ?? restoreError,
          });
    });
  };
  try {
    const workspaceRealPath = await fs.realpath(path.dirname(source.path));
    const claimRealPath = await fs.realpath(claimPath);
    if (claimRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, claimRealPath)) {
      throw new Error("claimed HEARTBEAT.md target escapes the agent workspace");
    }
    const claimed = await readRegularFile({
      filePath: claimRealPath,
      maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
    });
    const claimedContent = utf8Decoder.decode(claimed.buffer);
    if (hashCronScratchSource(claimedContent) !== source.sha256) {
      throw new Error("HEARTBEAT.md changed before the migration claim was acquired");
    }
  } catch (error) {
    await restore(error);
    throw error;
  }
  // Every final verification failure means "do not trust the import": restore
  // the claim and tag the error so the caller rolls newly copied scratch back.
  const changedError = (message: string, cause?: unknown) => {
    const error = new Error(message, cause !== undefined ? { cause } : undefined);
    error.name = HEARTBEAT_CLAIM_CHANGED_ERROR;
    return error;
  };
  const failChanged = async (message: string, cause?: unknown): Promise<never> => {
    const error = changedError(message, cause);
    await restore(error).catch(() => undefined);
    throw error;
  };
  const readFinalContent = async (filePath: string) => {
    const workspaceRealPath = await fs.realpath(path.dirname(source.path));
    const fileRealPath = await fs.realpath(filePath);
    if (fileRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, fileRealPath)) {
      throw new Error("HEARTBEAT.md target escapes the agent workspace");
    }
    const finalBytes = await readRegularFile({
      filePath: fileRealPath,
      maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
    });
    return utf8Decoder.decode(finalBytes.buffer);
  };
  const verifyUnchanged = async () => {
    // A holder of an already-open descriptor can still mutate the claimed
    // inode; re-verify the bytes before retiring it. The claim may itself be
    // a contained symlink, so resolve and containment-check it like the
    // initial claim did.
    const finalContent = await readFinalContent(claimPath).catch((error: unknown) =>
      failChanged("claimed HEARTBEAT.md could not be re-verified before finalization", error),
    );
    if (hashCronScratchSource(finalContent) !== source.sha256) {
      await failChanged("HEARTBEAT.md changed while the migration claim was held");
    }
    // An editor atomic-save can recreate the original path while the claim is
    // held. That recreation is the newest instruction set; treat it like a
    // changed claim so the import rolls back instead of shadowing it.
    let recreated: boolean;
    try {
      await fs.lstat(source.path);
      recreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await failChanged("could not verify the original HEARTBEAT.md path", error);
      }
      recreated = false;
    }
    if (recreated) {
      await failChanged("HEARTBEAT.md was recreated while the migration claim was held");
    }
  };
  const verifyRestoredUnchanged = async () => {
    let finalContent: string;
    try {
      finalContent = await readFinalContent(source.path);
    } catch (error) {
      throw changedError("restored HEARTBEAT.md could not be re-verified", error);
    }
    if (hashCronScratchSource(finalContent) !== source.sha256) {
      throw changedError("HEARTBEAT.md changed after the migration claim was restored");
    }
  };
  return {
    claimPath,
    restore,
    retain: async () => {
      await restore(undefined);
      await verifyRestoredUnchanged();
    },
    release: async ({ archivePath, verifyDestination }) => {
      await verifyUnchanged();
      // Retire the claim by moving the inode into the archive instead of
      // unlinking it: a writer holding an open descriptor that lands a write
      // after the hash check above still writes into the preserved archive
      // file, never into a deleted inode.
      const claimStat = await fs.lstat(claimPath);
      verifyDestination();
      if (claimStat.isSymbolicLink()) {
        // The removable entry is the symlink itself; its target file stays in
        // the workspace, so no open-descriptor write can be lost here.
        await fs.unlink(claimPath);
        return;
      }
      try {
        await fs.rename(claimPath, archivePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
          throw error;
        }
        // An open descriptor may still modify this inode. A cross-device copy
        // cannot safely retire it; keep the claim recoverable instead of unlinking.
        throw new Error(
          `Heartbeat source and archive are on different filesystems; the original is retained at ${claimPath}. Move the archive onto the workspace filesystem before retrying.`,
          { cause: error },
        );
      }
    },
  };
}

async function archiveSource(params: {
  agentId: string;
  source: HeartbeatSource;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const archivePath = archivePathForSource(params.agentId, params.source.sha256, params.env);
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(archivePath, params.source.content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await fs.readFile(archivePath, "utf8");
    if (hashCronScratchSource(existing) !== params.source.sha256) {
      throw new Error(`heartbeat migration archive collision at ${archivePath}`, { cause: error });
    }
  }
}

function migrationFinding(params: {
  agentId: string;
  path: string;
  requirement: string;
  message: string;
  severity?: HealthFinding["severity"];
}): HealthFinding {
  return {
    checkId: HEARTBEAT_SCRATCH_MIGRATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.path,
    target: params.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to migrate HEARTBEAT.md into cron scratch.`,
  };
}

/** Reports remaining workspace heartbeat files without changing them. */
export async function collectHeartbeatScratchMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const migrationAgents = resolveHeartbeatAgents(cfg);
  for (const agent of migrationAgents) {
    const heartbeatPath = path.join(
      resolveAgentWorkspaceDir(cfg, agent.agentId, env),
      LEGACY_HEARTBEAT_FILENAME,
    );
    try {
      const source = await readHeartbeatSource(cfg, agent.agentId, { env });
      if (!source) {
        continue;
      }
      findings.push(
        migrationFinding({
          agentId: agent.agentId,
          path: heartbeatPath,
          requirement: "legacy-heartbeat-file",
          message: `Agent "${agent.agentId}" still stores heartbeat instructions in HEARTBEAT.md.`,
        }),
      );
    } catch (error) {
      findings.push(
        migrationFinding({
          agentId: agent.agentId,
          path: heartbeatPath,
          requirement: "heartbeat-file-migration-blocked",
          severity: "error",
          message: `Agent "${agent.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
        }),
      );
    }
  }
  return findings;
}

/** Migrates each enrolled agent's heartbeat file into its stable monitor job. */
export async function maybeMigrateHeartbeatFilesToScratch(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<HeartbeatScratchMigrationResult> {
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  const migrationAgents = resolveHeartbeatAgents(params.cfg);
  if (!params.shouldRepair) {
    for (const agent of migrationAgents) {
      try {
        const source = await readHeartbeatSource(params.cfg, agent.agentId, { env });
        if (source) {
          note(
            `${shortenHomePath(source.path)} will migrate into automation scratch for ${agent.agentId}.`,
            "Heartbeat migration preview",
          );
        }
      } catch (error) {
        warnings.push(
          `Agent "${agent.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
        );
      }
    }
    if (warnings.length > 0) {
      note(warnings.join("\n"), "Doctor warnings");
    }
    return { changes, warnings };
  }

  let monitors: Map<string, CronJob>;
  try {
    monitors = await ensureHeartbeatMonitorJobs(params.cfg, storePath, env);
  } catch (error) {
    return {
      changes,
      warnings: [`Could not prepare heartbeat monitor jobs: ${errorMessage(error)}`],
    };
  }

  // Agents can share one workspace file. Group monitors by source path and
  // import into every monitor before the file is archived and removed once, so
  // the first agent's cleanup cannot starve its siblings.
  const groups = new Map<string, { source: HeartbeatSource; agents: [string, CronJob][] }>();
  for (const [agentId, monitor] of monitors) {
    let source: HeartbeatSource | undefined;
    try {
      source = await readHeartbeatSource(params.cfg, agentId, { recoverClaims: true, env });
    } catch (error) {
      warnings.push(`Agent "${agentId}" HEARTBEAT.md was not migrated: ${errorMessage(error)}`);
      continue;
    }
    if (!source) {
      continue;
    }
    const receipt = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId),
      { env },
    );
    if (receipt?.phase === "complete") {
      warnings.push(
        `Agent "${agentId}" has completed cutover; its newly present HEARTBEAT.md was retained without changing the operator-owned automation.`,
      );
      continue;
    }
    // Group by the directory entry being removed (canonical parent directory +
    // basename), not its resolved file target: two distinct symlinks pointing
    // at one shared file are each claimed and removed, while agents reaching
    // the same workspace through path aliases dedupe onto one entry.
    const group = groups.get(source.entryKey) ?? {
      source,
      agents: [],
    };
    group.agents.push([agentId, monitor]);
    groups.set(source.entryKey, group);
  }

  for (const { source, agents } of groups.values()) {
    // Precondition pass first: operator-owned scratch (different content or an
    // explicit unset tombstone) stays untouched while other owners can still
    // receive the source. Any skipped owner keeps the shared file in place.
    // The revision seen here is also the CAS token for the later write, so a
    // concurrent edit in between surfaces as a conflict, never an overwrite.
    let keepSource = false;
    const importAgents: [string, CronJob][] = [];
    let scratchWriteNeeded = false;
    const plannedRevisionByJobId = new Map<string, number>();
    for (const [agentId, monitor] of agents) {
      const state = readCronJobScratchState(storePath, monitor.id, { env });
      const current = state.scratch;
      plannedRevisionByJobId.set(monitor.id, state.currentRevision);
      if (state.currentRevision > 0 && !current) {
        warnings.push(`Agent "${agentId}" scratch was explicitly unset; it was left unchanged.`);
        keepSource = true;
      } else if (current && current.content !== source.content && !current.sourceSha256) {
        warnings.push(
          `Agent "${agentId}" already has different cron scratch; it was left unchanged.`,
        );
        keepSource = true;
      } else {
        importAgents.push([agentId, monitor]);
        if (current?.sourceSha256 !== source.sha256) {
          scratchWriteNeeded = true;
        }
      }
    }
    if (importAgents.length === 0 || (keepSource && !scratchWriteNeeded)) {
      continue;
    }

    if (!keepSource) {
      // Archive before the claim rename: if doctor dies mid-claim, the content is
      // already durable under the state backups instead of only at a hidden
      // .doctor-importing-* path nothing rescans.
      try {
        await archiveSource({ agentId: importAgents[0]![0], source, env });
      } catch (error) {
        warnings.push(
          `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
        );
        continue;
      }
    }

    // Claim before committing: once the file is renamed aside and hash-verified,
    // no concurrent editor can change the bytes that reach scratch. Retained
    // shared files are restored after the same verified import boundary.
    let claim: HeartbeatSourceClaim;
    try {
      claim = await claimHeartbeatSource(source);
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
      continue;
    }

    let importedAll = true;
    const verifiedScratch = new Map<string, ReturnType<typeof readCronJobScratchState>>();
    const groupChanges: string[] = [];
    for (const [agentId, monitor] of importAgents) {
      try {
        const currentJob = withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) =>
            loadedCronStoreFromRows(loadCronRows(db, cronStoreKey(storePath))).store.jobs.find(
              (job) => job.id === monitor.id,
            ),
          { env },
        );
        if (
          !currentJob ||
          !isDeepStrictEqual(
            projectCronJobThroughStorageCodec(currentJob),
            projectCronJobThroughStorageCodec(monitor),
          )
        ) {
          throw new Error("automation changed during scratch migration");
        }
        const state = readCronJobScratchState(storePath, monitor.id, { env });
        const shouldWriteScratch = state.scratch?.sourceSha256 !== source.sha256;
        if (shouldWriteScratch) {
          const write = writeCronJobScratch({
            storePath,
            jobId: monitor.id,
            content: source.content,
            expectedRevision: plannedRevisionByJobId.get(monitor.id) ?? state.currentRevision,
            sourceSha256: source.sha256,
            options: { env },
          });
          if (!write.ok) {
            throw new Error("scratch changed during migration");
          }
        }
        const destination = readCronJobScratchState(storePath, monitor.id, { env });
        const verified = destination.scratch;
        if (!verified || verified.sourceSha256 !== source.sha256) {
          throw new Error("scratch verification failed after write");
        }
        verifiedScratch.set(monitor.id, destination);
        if (!keepSource || shouldWriteScratch) {
          groupChanges.push(
            keepSource
              ? `Copied ${shortenHomePath(source.path)} into cron scratch for ${monitor.displayName ?? monitor.name}; retained the shared legacy file because another automation owner's scratch was left unchanged.`
              : `Migrated ${shortenHomePath(source.path)} into cron scratch for ${monitor.displayName ?? monitor.name}.`,
          );
        }
      } catch (error) {
        warnings.push(
          `Agent "${agentId}" scratch was not finalized: ${errorMessage(error)}. Rerun doctor to retry safely.`,
        );
        importedAll = false;
      }
    }
    // Pending cutover receipts fence execution. Keep migration-owned scratch on
    // interruption so retries can refresh it by CAS without ever resetting revisions.
    // An ordinary edit clears sourceSha256 and is never overwritten by a retry.
    if (!importedAll) {
      try {
        await claim.restore(undefined);
      } catch (error) {
        warnings.push(errorMessage(error));
      }
      continue;
    }
    if (keepSource) {
      try {
        await claim.retain();
        changes.push(...groupChanges);
      } catch (error) {
        warnings.push(
          `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
        );
      }
      continue;
    }
    try {
      // release() re-verifies the claimed bytes; when they changed it restores
      // the newer file itself and reports HeartbeatClaimChangedError.
      await claim.release({
        archivePath: archivePathForSource(importAgents[0]![0], source.sha256, env),
        verifyDestination: () => {
          const jobs =
            withExistingOpenClawStateDatabaseReadOnly(
              ({ db }) =>
                loadedCronStoreFromRows(loadCronRows(db, cronStoreKey(storePath))).store.jobs,
              { env },
            ) ?? [];
          for (const [, monitor] of importAgents) {
            const job = jobs.find((candidate) => candidate.id === monitor.id);
            if (
              !job ||
              !isDeepStrictEqual(
                projectCronJobThroughStorageCodec(job),
                projectCronJobThroughStorageCodec(monitor),
              ) ||
              !isDeepStrictEqual(
                readCronJobScratchState(storePath, monitor.id, { env }),
                verifiedScratch.get(monitor.id),
              )
            ) {
              throw new Error(
                "automation or scratch changed before source retirement; the migration claim was retained",
              );
            }
          }
        },
      });
      changes.push(...groupChanges);
    } catch (error) {
      if (error instanceof Error && error.name === HEARTBEAT_CLAIM_CHANGED_ERROR) {
        // The changed file remains authoritative until the pending cutover completes.
        warnings.push(
          `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
        );
        continue;
      }
      changes.push(...groupChanges);
      warnings.push(
        `${shortenHomePath(source.path)} was migrated but not removed: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
    }
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
