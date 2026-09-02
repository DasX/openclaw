import { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../bash-tools.exec-approval-request.js";
import { writeCliSystemPromptFile } from "./helpers.js";

export const executeDeps = {
  getProcessSupervisor: getProcessSupervisorImpl,
  writeCliSystemPromptFile,
  invokeNodeClaudeCliRun,
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
};

export type CliExecuteDeps = typeof executeDeps;
