import { coerceErrorMessage } from "@openclaw/normalization-core";
import { unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabaseByPath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  CLAW_PORTABLE_HEARTBEAT_ID,
  clawCronGatewayJobMatchesRef,
  deleteClawCronRef,
  markClawCronRefRemoved,
  type ClawCronGateway,
} from "./cron.js";
import {
  clawBootstrapStateBlocksRemove,
  removeClawBootstrap,
} from "./lifecycle-bootstrap-removal.js";
import { claimClawAgentConfigRemoval, type ConfigCommit } from "./lifecycle-config-removal.js";
import {
  clawRemoveQuietRuntime,
  ClawRemoveError,
  cleanupClawAgentFilesystem,
  releaseClawRemoveRows,
  removeClawWorkspaceFile,
  workspaceContainsUntrackedEntries,
  type ClawTrashPath,
  type RemovedWorkspaceFile,
} from "./lifecycle-delete-support.js";
import { removeClawMcpServers } from "./lifecycle-mcp-removal.js";
import type {
  ClawRemovePlan,
  RemovedCronJob,
  RemovedMcpServer,
} from "./lifecycle-remove-contract.js";
import { buildClawRemovePlan } from "./lifecycle-remove-plan.js";
import { readClawStatus } from "./lifecycle-status.js";
import { planClawMcpServerRemoval } from "./mcp.js";
import {
  applyClawPackageRemovals,
  planClawPackageRemovals,
  type ClawPackageRemovalResult,
  type ClawReferencedCleanup,
  type PackageRemovalDeps,
} from "./package-remove.js";
import { portableHeartbeatStateDigest } from "./portable-heartbeat-update.js";
import {
  readPortableHeartbeatState,
  removePortableHeartbeat,
  publishPortableHeartbeat,
} from "./portable-heartbeat.js";
import { updateClawInstallRecordStatus } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export { ClawRemoveError } from "./lifecycle-delete-support.js";
export { CLAW_REMOVE_PLAN_SCHEMA_VERSION } from "./lifecycle-remove-contract.js";
export { readClawStatus, type ClawStatusRecord } from "./lifecycle-status.js";

export const CLAW_REMOVE_RESULT_SCHEMA_VERSION = "openclaw.clawRemoveResult.v1" as const;
type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  status: "complete" | "partial";
  agentId: string;
  agentRemoved: boolean;
  bootstrap?: RemovedWorkspaceFile;
  workspaceFiles: RemovedWorkspaceFile[];
  packages: ClawPackageRemovalResult[];
  mcpServers: RemovedMcpServer[];
  cronJobs: RemovedCronJob[];
  packageRefsReleased: number;
  error?: { code: string; message: string };
};

export { buildClawRemovePlan } from "./lifecycle-remove-plan.js";

type PurgeSessions = (config: OpenClawConfig, agentId: string) => Promise<void>;
export async function applyClawRemovePlan(
  plan: ClawRemovePlan,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    commitConfig?: ConfigCommit;
    packageDeps?: PackageRemovalDeps;
    referencedCleanup?: ClawReferencedCleanup;
    purgeSessions?: PurgeSessions;
    trashPath?: ClawTrashPath;
    consentPlanIntegrity?: string;
    unsetMcpServer?: typeof unsetConfiguredMcpServer;
    cronGateway?: Pick<ClawCronGateway, "get" | "list" | "remove">;
  } = {},
): Promise<ClawRemoveResult> {
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw remove plan; run remove --dry-run again.",
    );
  }
  if (plan.blockers.length > 0 || !plan.agentId) {
    throw new ClawRemoveError("remove_blocked", "The Claw remove plan contains blockers.");
  }
  const currentPlan = await buildClawRemovePlan(plan.target, options);
  if (currentPlan.planIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const agentId = plan.agentId;
  const plannedAgentAction = plan.actions.find(
    (action) => action.kind === "agent" && action.id === agentId,
  );
  const expectedRemovalSurfaceDigest = plannedAgentAction?.details?.removalSurfaceDigest;
  if (typeof expectedRemovalSurfaceDigest !== "string") {
    throw new ClawRemoveError("remove_changed", "Claw remove plan is missing config state.");
  }
  const current = await readClawStatus(plan.agentId, options);
  const record = current.records[0];
  if (
    !record ||
    record.agentState === "modified" ||
    clawBootstrapStateBlocksRemove(record) ||
    record.workspaceFiles.some((file) => file.state === "unsafe") ||
    record.mcpServers.some((server) => server.state === "pending")
  ) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
    ...options,
    deps: options.packageDeps,
    referencedCleanup: options.referencedCleanup
      ? {
          ...options.referencedCleanup,
          selected: (options.referencedCleanup.selected ?? []).filter(
            (selector) => !selector.startsWith("mcp:"),
          ),
        }
      : undefined,
  });
  const plannedPackages = plan.actions
    .filter((action) => action.kind === "packageRef")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentPackages = packageDecisions
    .map(
      (decision) =>
        `${decision.packageRef.kind}:${decision.packageRef.ref}@${decision.packageRef.version}:${decision.action === "uninstall" ? "uninstall" : "release"}`,
    )
    .toSorted();
  if (JSON.stringify(plannedPackages) !== JSON.stringify(currentPackages)) {
    throw new ClawRemoveError("remove_changed", "Package ownership changed after remove planning.");
  }
  const plannedMcpServers = plan.actions
    .filter((action) => action.kind === "mcpServer")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentMcpServers = record.mcpServers
    .map((server) => `${server.name}:${planClawMcpServerRemoval(server, options).action}`)
    .toSorted();
  if (JSON.stringify(plannedMcpServers) !== JSON.stringify(currentMcpServers)) {
    throw new ClawRemoveError("remove_changed", "MCP ownership changed after remove planning.");
  }
  const mcpRemoval = await removeClawMcpServers({
    agentId: plan.agentId,
    servers: record.mcpServers,
    options,
  });
  const mcpServers = mcpRemoval.mcpServers;
  if (mcpRemoval.error) {
    updateClawInstallRecordStatus(agentId, "partial", options);
    return {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      status: "partial",
      agentId,
      agentRemoved: false,
      workspaceFiles: [],
      packages: [],
      mcpServers,
      cronJobs: [],
      packageRefsReleased: 0,
      error: { code: "mcp_cleanup_failed", message: mcpRemoval.error },
    };
  }
  const cronJobs: RemovedCronJob[] = [];
  for (const cron of record.cronJobs) {
    if (cron.status !== "removed" && (!cron.schedulerJobId || cron.status !== "complete")) {
      throw new ClawRemoveError(
        "cron_cleanup_uncertain",
        `Cron declaration ${JSON.stringify(cron.manifestId)} is not safely removable.`,
      );
    }
    if (cron.status !== "removed" && (!options.cronGateway?.get || !options.cronGateway.remove)) {
      throw new ClawRemoveError(
        "cron_gateway_required",
        "Claw cron jobs require the gateway-owned cron.get and cron.remove APIs.",
      );
    }
    try {
      if (cron.status !== "removed") {
        const live = await options.cronGateway!.get!(cron.schedulerJobId!);
        if (live != null && !clawCronGatewayJobMatchesRef(plan.agentId, cron, live)) {
          throw new Error(
            `Cron declaration ${JSON.stringify(cron.manifestId)} changed after planning.`,
          );
        }
        if (live != null) {
          try {
            await options.cronGateway!.remove(cron.schedulerJobId!);
          } catch (removeError) {
            // A transport failure can lose a successful cron.remove response. Re-read the
            // gateway before preserving ownership so retries can converge on confirmed absence.
            const afterRemove = await options.cronGateway!.get!(cron.schedulerJobId!);
            if (afterRemove != null) {
              throw removeError;
            }
          }
        }
        markClawCronRefRemoved(plan.agentId, cron.manifestId, options);
      }
      deleteClawCronRef(plan.agentId, cron.manifestId, options);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "removed",
      });
    } catch (error) {
      const message = coerceErrorMessage(error);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "error",
        message,
      });
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId: plan.agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages: [],
        mcpServers,
        cronJobs,
        packageRefsReleased: 0,
        error: { code: "cron_cleanup_failed", message },
      };
    }
  }
  const portableAction = plan.actions.find(
    (action) => action.kind === "cronJob" && action.id === CLAW_PORTABLE_HEARTBEAT_ID,
  );
  if (portableAction) {
    const config = options.config ?? getRuntimeConfig();
    const portable = readPortableHeartbeatState(agentId, config, options);
    if (portableHeartbeatStateDigest(portable) !== portableAction.details?.stateDigest) {
      throw new ClawRemoveError("remove_changed", "Portable automation changed during removal.");
    }
    removePortableHeartbeat(agentId, config, portable, options);
    await publishPortableHeartbeat(agentId, config, options);
    cronJobs.push({
      manifestId: CLAW_PORTABLE_HEARTBEAT_ID,
      schedulerJobId: portable.receipt?.jobId,
      action: "removed",
    });
  }
  const configRemoval = await claimClawAgentConfigRemoval({
    agentId,
    expectedDigest: record.install.agentConfigDigest,
    expectedRemovalSurfaceDigest,
    expectedState: record.agentState,
    fallbackWorkspace: record.install.workspace,
    config: options.config,
    commitConfig: options.commitConfig,
    stateDatabase: options,
    trashPath: options.trashPath,
    onModified: () => new ClawRemoveError("agent_modified", "Agent config changed during remove."),
  });
  const { agentRemoved, cleanupTargets, configBeforeDelete } = configRemoval;
  const committedNextConfig = configRemoval.nextConfig;
  const completeDeletion = configRemoval.completeDeletion;
  if (!options.commitConfig || options.purgeSessions) {
    const purgeSessions =
      options.purgeSessions ??
      (await import("../config/sessions/cleanup-service.js")).purgeAgentSessionStoreEntries;
    await purgeSessions(configBeforeDelete, agentId);
  }
  closeOpenClawAgentDatabaseByPath(resolveOpenClawAgentSqlitePath({ agentId, env: options.env }));
  const packages = await applyClawPackageRemovals(
    packageDecisions.toSorted(
      (left, right) =>
        Number(left.packageRef.relationship === "referenced") -
        Number(right.packageRef.relationship === "referenced"),
    ),
    {
      ...options,
      deps: options.packageDeps,
    },
  );
  const packageErrors = packages.filter((pkg) => pkg.action === "error");
  if (packageErrors.length > 0) {
    updateClawInstallRecordStatus(agentId, "partial", options);
    return {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      status: "partial",
      agentId: plan.agentId,
      agentRemoved,
      workspaceFiles: [],
      packages,
      mcpServers,
      cronJobs,
      packageRefsReleased: 0,
      error: {
        code: "package_cleanup_failed",
        message: packageErrors.map((pkg) => pkg.reason).join("; "),
      },
    };
  }
  const workspaceFiles: RemovedWorkspaceFile[] = [];
  for (const file of record.workspaceFiles) {
    workspaceFiles.push(await removeClawWorkspaceFile(file));
  }
  const bootstrap = await removeClawBootstrap(record);
  const cleanupErrors = workspaceFiles
    .filter((file) => file.action === "error")
    .map((file) => file.message ?? `Could not remove ${file.path}.`);
  if (bootstrap?.action === "error") {
    cleanupErrors.push(bootstrap.message ?? `Could not remove ${bootstrap.path}.`);
  }
  if (cleanupErrors.length === 0 && cleanupTargets && committedNextConfig) {
    const workspaceHasRemainingEntries = await workspaceContainsUntrackedEntries(
      cleanupTargets.workspaceDir,
      record.workspaceFiles.map((file) => file.path),
    );
    cleanupErrors.push(
      ...(await cleanupClawAgentFilesystem({
        agentId,
        nextConfig: committedNextConfig,
        targets: cleanupTargets,
        runtime: clawRemoveQuietRuntime,
        trashPath: options.trashPath,
        retainWorkspace:
          workspaceHasRemainingEntries ||
          bootstrap?.action === "retainedModified" ||
          workspaceFiles.some((file) => file.action === "retainedModified"),
      })),
    );
  }
  const complete = cleanupErrors.length === 0;
  if (!complete) {
    updateClawInstallRecordStatus(agentId, "partial", options);
  }
  releaseClawRemoveRows(plan.agentId, workspaceFiles, complete, completeDeletion, options);
  return {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    status: complete ? "complete" : "partial",
    agentId: plan.agentId,
    agentRemoved,
    ...(bootstrap ? { bootstrap } : {}),
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
    packageRefsReleased: complete ? record.packages.length : 0,
    ...(complete
      ? {}
      : {
          error: {
            code: "workspace_cleanup_failed",
            message: cleanupErrors.join("; "),
          },
        }),
  };
}
