import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { getRuntimeConfig } from "../config/config.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { CLAW_PORTABLE_HEARTBEAT_ID } from "./cron.js";
import {
  clawBootstrapStateBlocksRemove,
  planClawBootstrapRemoval,
} from "./lifecycle-bootstrap-removal.js";
import { digestClawAgentRemovalSurface } from "./lifecycle-config-removal.js";
import {
  deletionEffects,
  readAttachedCronJobs,
  workspaceContainsUntrackedEntries,
} from "./lifecycle-delete-support.js";
import {
  CLAW_REMOVE_PLAN_SCHEMA_VERSION,
  type ClawRemovePlan,
  type ClawRemovePlanAction,
} from "./lifecycle-remove-contract.js";
import { readClawStatus } from "./lifecycle-status.js";
import { clawMcpRemovalSelector, planClawMcpServerRemoval } from "./mcp.js";
import { projectClawPackageRemovePlan } from "./package-remove-plan.js";
import {
  planClawPackageRemovals,
  type ClawReferencedCleanup,
  type PackageRemovalDeps,
} from "./package-remove.js";
import {
  portableHeartbeatStateDigest,
  portableHeartbeatDrift,
} from "./portable-heartbeat-update.js";
import { readPortableHeartbeatState } from "./portable-heartbeat.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export async function buildClawRemovePlan(
  target: string,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    packageDeps?: PackageRemovalDeps;
    referencedCleanup?: ClawReferencedCleanup;
  } = {},
): Promise<ClawRemovePlan> {
  const status = await readClawStatus(target, options);
  const blockers: ClawRemovePlan["blockers"] = [];
  if (status.records.length === 0) {
    blockers.push({
      code: "claw_not_found",
      message: `No installed Claw matches ${JSON.stringify(target)}.`,
    });
  } else if (status.records.length > 1) {
    blockers.push({
      code: "claw_ambiguous",
      message: `Claw name ${JSON.stringify(target)} matches multiple agents; use an agent id.`,
    });
  }
  const record = status.records.length === 1 ? status.records[0] : undefined;
  if (record?.agentState === "modified") {
    blockers.push({
      code: "agent_modified",
      message: `Agent ${JSON.stringify(record.install.agentId)} changed after add.`,
    });
  }
  for (const file of record?.workspaceFiles ?? []) {
    if (file.state === "unsafe") {
      blockers.push({
        code: "workspace_file_unsafe",
        message: `${file.path}: ${file.message ?? "unsafe file"}`,
      });
    }
  }
  if (record && clawBootstrapStateBlocksRemove(record)) {
    blockers.push({
      code: "bootstrap_cleanup_uncertain",
      message: `BOOTSTRAP.md has ${record.bootstrap.state} ownership state and must be reconciled before removal.`,
    });
  }
  for (const server of record?.mcpServers ?? []) {
    if (server.state === "pending") {
      blockers.push({
        code: "mcp_cleanup_uncertain",
        message: `MCP server ${JSON.stringify(server.name)} has ${server.state} ownership state and must be reconciled before removal.`,
      });
    }
  }
  for (const cron of record?.cronJobs ?? []) {
    if (cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId)) {
      blockers.push({
        code: "cron_cleanup_uncertain",
        message: `Cron declaration ${JSON.stringify(cron.manifestId)} has ${cron.status} ownership state and must be reconciled before removal.`,
      });
    }
  }
  const actions: ClawRemovePlanAction[] = [];
  if (record) {
    const selectedResources = options.referencedCleanup?.selected ?? [];
    const packageCleanup = options.referencedCleanup
      ? {
          ...options.referencedCleanup,
          selected: selectedResources.filter((selector) => !selector.startsWith("mcp:")),
        }
      : undefined;
    const mcpCleanup = options.referencedCleanup
      ? {
          ...options.referencedCleanup,
          selected: selectedResources.filter((selector) => selector.startsWith("mcp:")),
        }
      : undefined;
    const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
      ...options,
      deps: options.packageDeps,
      referencedCleanup: packageCleanup,
    });
    const packagePlan = projectClawPackageRemovePlan({
      decisions: packageDecisions,
      inspections: record.packages,
      cleanup: packageCleanup,
    });
    blockers.push(...packagePlan.blockers);
    const effects = deletionEffects(
      options.config ?? getRuntimeConfig(),
      record.install.agentId,
      record.install.workspace,
    );
    const workspaceHasModifiedFiles =
      record.workspaceFiles.some((file) => file.state === "modified") ||
      record.bootstrap.state === "modified";
    const trackedWorkspacePaths = [
      ...record.workspaceFiles.map((file) => file.path),
      ...(record.install.bootstrap && record.bootstrap.state === "pending"
        ? [record.bootstrap.path]
        : []),
    ];
    const workspaceHasUntrackedEntries = await workspaceContainsUntrackedEntries(
      record.install.workspace,
      trackedWorkspacePaths,
    );
    const attachedJobs = readAttachedCronJobs(record.install.agentId, options);
    const ownedSchedulerJobIds = new Set(
      record.cronJobs
        .filter((cron) => cron.status !== "removed" && cron.schedulerJobId)
        .map((cron) => cron.schedulerJobId),
    );
    const portable = readPortableHeartbeatState(
      record.install.agentId,
      options.config ?? getRuntimeConfig(),
      options,
    );
    if (portable.ref && portable.ref.status !== "removed") {
      if (portable.receipt && portable.receipt.jobId === portable.ref.schedulerJobId) {
        ownedSchedulerJobIds.add(portable.receipt.jobId);
      }
      const blocked = portable.job
        ? portableHeartbeatDrift(portable)
        : portable.receipt?.phase !== "complete";
      if (blocked) {
        blockers.push({
          code: "portable_automation_drift",
          message:
            "Portable automation ownership, definition or scratch changed; reconcile before Claw removal.",
        });
      }
      actions.push({
        kind: "cronJob",
        id: CLAW_PORTABLE_HEARTBEAT_ID,
        action: "remove",
        target: portable.receipt?.jobId ?? "unresolved",
        blocked,
        details: { stateDigest: portableHeartbeatStateDigest(portable) },
      });
    }
    for (const job of attachedJobs.filter((candidate) => !ownedSchedulerJobIds.has(candidate.id))) {
      blockers.push({
        code: "agent_job_attached",
        message: `Cron job ${JSON.stringify(job.id)} still references agent ${JSON.stringify(record.install.agentId)}; reassign or remove it first.`,
      });
    }
    actions.push({
      kind: "agent",
      id: record.install.agentId,
      action: "remove",
      target: `agents.entries[${JSON.stringify(record.install.agentId)}]`,
      blocked: record.agentState === "modified",
      details: {
        expectedState: record.agentState,
        configDigest: record.install.agentConfigDigest,
        removalSurfaceDigest: digestClawAgentRemovalSurface(
          options.config ?? getRuntimeConfig(),
          record.install.agentId,
        ),
        ownedPaths: record.install.agentOwnedPaths,
      },
      ...(record.agentState === "modified" ? { reason: "Agent config digest changed." } : {}),
    });
    if (effects.pruned.removedBindings > 0) {
      actions.push({
        kind: "configBinding",
        id: record.install.agentId,
        action: "remove",
        target: `bindings[agentId=${record.install.agentId}]`,
        blocked: record.agentState === "modified",
        details: { count: effects.pruned.removedBindings },
      });
    }
    if (effects.pruned.removedAllow > 0) {
      actions.push({
        kind: "agentAllow",
        id: record.install.agentId,
        action: "remove",
        target: `tools.agentToAgent.allow[${record.install.agentId}]`,
        blocked: record.agentState === "modified",
        details: { count: effects.pruned.removedAllow },
      });
    }
    if (effects.workspace) {
      actions.push({
        kind: "workspace",
        id: record.install.agentId,
        action:
          effects.workspaceRetained || workspaceHasModifiedFiles || workspaceHasUntrackedEntries
            ? "retain"
            : "trash",
        target: effects.workspace,
        blocked: record.agentState === "modified",
        details: {
          retained:
            effects.workspaceRetained || workspaceHasModifiedFiles || workspaceHasUntrackedEntries,
          sharedWith: effects.workspaceSharedWith,
        },
        ...(effects.workspaceRetained
          ? { reason: "Workspace overlaps another agent." }
          : workspaceHasModifiedFiles
            ? { reason: "Workspace contains locally modified Claw-managed files." }
            : workspaceHasUntrackedEntries
              ? { reason: "Workspace contains files or directories not managed by this Claw." }
              : {}),
      });
    }
    if (effects.agentDir) {
      actions.push({
        kind: "agentState",
        id: record.install.agentId,
        action: "trash",
        target: effects.agentDir,
        blocked: record.agentState === "modified",
      });
    }
    actions.push({
      kind: "sessionIndex",
      id: record.install.agentId,
      action: "delete",
      target: `session store entries for agent:${record.install.agentId}`,
      blocked: record.agentState === "modified",
    });
    actions.push({
      kind: "sessionTranscripts",
      id: record.install.agentId,
      action: "trash",
      target: effects.sessionsDir,
      blocked: record.agentState === "modified",
    });
    for (const job of attachedJobs.filter((candidate) => !ownedSchedulerJobIds.has(candidate.id))) {
      actions.push({
        kind: "scheduledJob",
        id: job.id,
        action: "retain",
        target: `cron_jobs:${job.id}`,
        blocked: true,
        reason: "Operator-owned scheduled work must be reassigned or removed explicitly.",
        details: {
          name: job.name,
          enabled: job.enabled,
          agentId: job.agentId,
          ownerAgentId: job.ownerAgentId,
        },
      });
    }
    for (const file of record.workspaceFiles) {
      actions.push({
        kind: "workspaceFile",
        id: file.path,
        action: file.state === "unchanged" ? "delete" : "retain",
        target: `${file.workspace}:${file.path}`,
        blocked: file.state === "unsafe",
        details: {
          expectedState: file.state,
          contentDigest: file.contentDigest,
          workspace: file.workspace,
        },
        ...(file.state === "modified"
          ? { reason: "Local content changed; preserve the file." }
          : {}),
      });
    }
    const bootstrapAction = planClawBootstrapRemoval(record);
    if (bootstrapAction) {
      actions.push(bootstrapAction);
    }
    actions.push(...packagePlan.actions);
    const unmatchedMcpSelectors = new Set(mcpCleanup?.selected ?? []);
    for (const server of record.mcpServers) {
      const blocked = server.state === "pending";
      const decision = planClawMcpServerRemoval(server, {
        ...options,
        referencedCleanup: mcpCleanup,
      });
      unmatchedMcpSelectors.delete(clawMcpRemovalSelector(server));
      if (decision.blocked) {
        blockers.push({
          code: "referenced_cleanup_requires_override",
          message: `${clawMcpRemovalSelector(server)}: ${decision.reason ?? "explicit conflict override is required"}`,
        });
      }
      actions.push({
        kind: "mcpServer",
        id: server.name,
        action: blocked ? "retain" : decision.action,
        target: `mcp.servers.${server.name}`,
        blocked,
        details: {
          expectedState: server.state,
          configDigest: server.configDigest,
          relationship: server.relationship,
          origin: server.origin,
          independentOwner: server.independentOwner,
          affectedClawAgentIds: decision.affectedClawAgentIds,
          cleanupMode: mcpCleanup?.mode ?? "retain",
          availableCleanupModes:
            server.relationship === "referenced"
              ? ["retain", "remove-if-unused", "remove-selected"]
              : ["remove"],
        },
        ...(blocked
          ? { reason: `MCP ownership state is ${server.state}.` }
          : decision.reason
            ? { reason: decision.reason }
            : {}),
      });
    }
    for (const selector of unmatchedMcpSelectors) {
      blockers.push({
        code: "referenced_cleanup_not_found",
        message: `Selected referenced resource ${JSON.stringify(selector)} is not owned by this Claw.`,
      });
    }
    for (const cron of record.cronJobs) {
      const blocked =
        cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId);
      actions.push({
        kind: "cronJob",
        id: cron.manifestId,
        action: blocked ? "retain" : "remove",
        target: cron.schedulerJobId ?? cron.declarationKey,
        blocked,
        details: {
          expectedStatus: cron.status,
          declarationKey: cron.declarationKey,
          schedulerJobId: cron.schedulerJobId,
          job: cron.job,
        },
        ...(blocked ? { reason: `Cron ownership state is ${cron.status}.` } : {}),
      });
    }
    actions.push({
      kind: "installRecord",
      id: record.install.agentId,
      action: "remove",
      target: `claw_installs:${record.install.agentId}`,
      blocked: false,
      details: {
        expectedStatus: record.install.status,
        planIntegrity: record.install.planIntegrity,
        sourceIntegrity: record.install.claw.integrity,
      },
    });
  }
  const planIdentity = {
    target,
    agentId: record?.install.agentId,
    actions,
    blockers,
  };
  return {
    schemaVersion: CLAW_REMOVE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: `sha256:${createHash("sha256")
      .update(stableStringify(planIdentity))
      .digest("hex")}`,
    target,
    ...(record ? { agentId: record.install.agentId } : {}),
    actions,
    blockers,
  };
}
