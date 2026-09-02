import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { abortable } from "../../agents/embedded-agent-runner/run/abortable.js";
import { FailoverError, resolveModelFallbackError } from "../../agents/failover-error.js";
import { runFallbackAttempt } from "../../agents/model-fallback-attempt.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  attachErrorDiagnostic,
  formatErrorMessageForDisplay,
} from "../../infra/error-diagnostics.js";
import { saveMediaBuffer } from "../../media/store.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { PreparedWorkerComputer } from "./computer-transport.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  credential,
  cleanupWorkerTurnLauncherTest,
  computerDescriptor,
  createWorkerSessionTurnPlacementProvider,
  measureLaunchTurn,
  placements,
  root,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  sessionTarget,
  turn,
  unusedEnvironments,
  withWorkerCompactionAdoption,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("worker desktop and image launch", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.each([
    { missingFeature: undefined, modelHasVision: undefined, allowed: true },
    { missingFeature: undefined, modelHasVision: true, allowed: true },
    { missingFeature: undefined, modelHasVision: false, allowed: false },
    { missingFeature: WORKER_COMPUTER_PROTOCOL_FEATURE, modelHasVision: true, allowed: false },
  ])(
    "grants computer with negotiated features and model vision (missing: $missingFeature, vision: $modelHasVision)",
    async ({ missingFeature, modelHasVision, allowed }) => {
      seedActivePlacement();
      const environment = attachedEnvironment();
      if (!missingFeature) {
        environment.bootstrapReceipt!.protocolFeatures.push(WORKER_COMPUTER_PROTOCOL_FEATURE);
      }
      const computer = computerDescriptor("worker-desktop");
      const image = {
        type: "image" as const,
        data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
        mimeType: "image/png",
      };
      const bind = vi.fn(() => ({ resolveNode: async () => computer, invoke: vi.fn() }));
      const prepareComputer = vi.fn(async () => ({
        descriptor: computer,
        bind,
        close: vi.fn(async () => {}),
      }));
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        expect(plan.assignment.computer).toEqual(allowed ? computer : undefined);
        const prompt = plan.assignment.prompt;
        const images = Array.isArray(prompt) ? prompt.filter((part) => part.type === "image") : [];
        expect(images).toEqual(modelHasVision === true ? [image] : []);
        expect(plan.assignment.toolAuthority.allowedToolNames.includes("computer")).toBe(allowed);
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        launchTurn,
        measureLaunchTurn,
        stageAttachments: vi.fn(async () => {}),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const environments = {
        ...unusedEnvironments(),
        get: vi.fn(() => environment),
        acquireTurnCredential: vi.fn(async () => credential()),
        startTunnel: vi.fn(async () => tunnel),
        prepareComputer,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      await expect(
        provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-computer",
          },
          { ...turn("run-computer"), toolsAllow: ["computer"], modelHasVision, images: [image] },
          async () => ({ meta: { durationMs: 1 } }),
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      expect(launchTurn).toHaveBeenCalledOnce();
      expect(tunnel.stageAttachments).toHaveBeenCalledTimes(modelHasVision === true ? 1 : 0);
      expect(prepareComputer).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(bind).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it.each<{
    label: string;
    nodeDeviceId?: string;
    providerId: string;
    closeFails: boolean;
    primary?: "provider" | "abort" | "timeout";
  }>([
    { label: "SSH", nodeDeviceId: undefined, providerId: "fake", closeFails: false },
    {
      label: "paired-device",
      nodeDeviceId: "paired-node-1",
      providerId: "device",
      closeFails: false,
    },
    { label: "cloud-node", nodeDeviceId: "cloud-node-1", providerId: "crabbox", closeFails: false },
    { label: "cloud-node", nodeDeviceId: "cloud-node-1", providerId: "crabbox", closeFails: true },
    ...(["provider", "abort", "timeout"] as const).flatMap((primary) =>
      [false, true].map((closeFails) => ({
        label: primary,
        nodeDeviceId: "paired-node-1",
        providerId: "device",
        primary,
        closeFails,
      })),
    ),
  ])(
    "restores a $label remote-exec attachment prompt before computer cleanup (close fails: $closeFails)",
    async ({ nodeDeviceId, providerId, closeFails, primary }) => {
      const primaryError =
        primary === "provider"
          ? new FailoverError("provider failed", { reason: "auth", status: 401 })
          : primary === "abort"
            ? createAgentRunDirectAbortError()
            : primary === "timeout"
              ? await abortable(
                  AbortSignal.abort(new DOMException("turn timed out", "TimeoutError")),
                  Promise.resolve(),
                ).catch((error: unknown) => {
                  if (!(error instanceof Error)) {
                    throw error;
                  }
                  return error;
                })
              : undefined;
      if (primaryError) {
        attachErrorDiagnostic(primaryError, "original provider diagnostic");
        Object.freeze(primaryError);
      }
      const remote = path.join(await realpath(root), "remote");
      await mkdir(remote);
      const bytes = Buffer.from("remote attachment");
      const saved = await saveMediaBuffer(bytes, "text/plain", "inbound", bytes.length, "note.txt");
      const inputTurn = {
        ...turn("run-remote-exec"),
        transcriptPrompt: "Canonical transcript request",
        media: [{ path: saved.path, contentType: "text/plain" }],
      };
      const originalPrompt = inputTurn.prompt;
      seedActivePlacement("remote-exec", remote);
      const order: string[] = [];
      const launchTurn = vi.fn();
      const quiesceWorkspace = vi.fn(async () => {
        order.push("quiesce");
        return {
          assertActive: vi.fn(async () => {}),
          resume: vi.fn(async () => {
            order.push("resume");
          }),
        };
      });
      const reconcileWorkspace = vi.fn(
        async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
          order.push("reconcile");
          request.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: vi.fn(async () => {}),
            verifyLocalStable: vi.fn(async () => {}),
          };
        },
      );
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        measureLaunchTurn,
        launchTurn,
        runWorkspaceCommand: async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5_000,
            signal: command.signal,
          }),
        quiesceWorkspace,
        syncWorkspace: vi.fn(),
        reconcileWorkspace,
        stop: vi.fn(async () => {}),
      };
      const cleanupError = new AggregateError(
        [new Error("native close failed")],
        "computer close failed",
      );
      const closeComputer = vi.fn(async () => {
        expect(inputTurn.prompt).toBe(originalPrompt);
        expect(inputTurn.transcriptPrompt).toBe("Canonical transcript request");
        order.push("close");
        if (closeFails) {
          throw cleanupError;
        }
      });
      const computer: PreparedWorkerComputer = {
        descriptor: computerDescriptor(nodeDeviceId ?? "unused-ssh-node"),
        bind: () => {
          throw new Error("unexpected computer binding");
        },
        close: closeComputer,
      };
      const environments: WorkerTurnEnvironmentService = {
        ...unusedEnvironments(),
        get: vi.fn(() =>
          nodeDeviceId
            ? { ...attachedEnvironment(), providerId, nodeDeviceId, sshEndpoint: null }
            : attachedEnvironment(),
        ),
        startTunnel: vi.fn(async () => tunnel),
        prepareComputer: vi.fn(async () => (nodeDeviceId ? computer : undefined)),
      };
      const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
      const successorGate = vi.spyOn(provider, "assertCompactionSuccessorAllowed");
      let retainedNodeAuthority: (() => void) | undefined;
      const runLocal = vi.fn(() =>
        withWorkerCompactionAdoption("run-remote-exec", async (adopt) => {
          order.push("local");
          expect(inputTurn.prompt).toContain(`${originalPrompt}\n\nCurrent attachment originals`);
          expect(inputTurn.transcriptPrompt).toBe("Canonical transcript request");
          const placementBefore = placements.get(SESSION_ID);
          const entryBefore = loadSessionEntry(sessionTarget);
          expect(placementBefore?.turnClaim).toMatchObject({
            owner: "local",
            runId: "run-remote-exec",
          });
          await expect(adopt(SESSION_ID)).resolves.toBeUndefined();
          expect(successorGate).not.toHaveBeenCalled();
          await expect(adopt("session-remote-successor")).rejects.toThrow(
            /worker placement.*same session ID/u,
          );
          expect(placements.get(SESSION_ID)).toEqual(placementBefore);
          expect(loadSessionEntry(sessionTarget)).toEqual(entryBefore);
          expect(placements.get("session-remote-successor")).toBeUndefined();
          if (nodeDeviceId) {
            const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertNodeExecutionCurrent;
            expect(assertCurrent).toBeTypeOf("function");
            const request = {
              runId: "run-remote-exec",
              agentId: "main",
              nodeId: nodeDeviceId,
              workspace: {
                workspaceDir: remote,
                environmentId: ENVIRONMENT_ID,
                sessionId: SESSION_ID,
                sessionKey: SESSION_KEY,
                ownerEpoch: OWNER_EPOCH,
              },
            };
            retainedNodeAuthority = () => assertCurrent!(request);
            retainedNodeAuthority();
            for (const changed of [
              { ...request, runId: "other" },
              { ...request, nodeId: "other" },
              ...[
                { ownerEpoch: OWNER_EPOCH + 1 },
                { environmentId: "other" },
                { sessionId: "other" },
                { workspaceDir: "/other" },
              ].map((workspace) =>
                Object.assign({}, request, {
                  workspace: Object.assign({}, request.workspace, workspace),
                }),
              ),
            ]) {
              expect(() => assertCurrent!(changed)).toThrow("no longer current");
            }
            const original = environments.get(ENVIRONMENT_ID)!;
            if (original.state !== "attached") {
              throw new Error("expected an attached environment");
            }
            for (const changed of [
              { ...original, nodeDeviceId: "replacement" },
              { ...original, leaseId: "replacement" },
            ]) {
              vi.mocked(environments.get).mockReturnValueOnce(changed);
              await Promise.resolve();
              expect(retainedNodeAuthority).toThrow("no longer current");
            }
          }
          if (primaryError) {
            throw primaryError;
          }
          return { payloads: [{ text: "local remote reply" }], meta: { durationMs: 1 } };
        }),
      );

      const uninstall = installSessionPlacementAdmissionProvider(provider);
      try {
        const operation = provider.executeTurn(
          {
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            agentId: "main",
            runId: "run-remote-exec",
          },
          inputTurn,
          runLocal,
        );
        if (primaryError) {
          const failure = await operation.catch((error: unknown) => error);
          expect(failure).toBe(primaryError);
          const display = formatErrorMessageForDisplay(failure);
          expect(display).toContain("original provider diagnostic");
          if (closeFails) {
            expect(display).toContain("computer close failed | native close failed");
          }
          const run = vi.fn(async () => {
            throw failure;
          });
          const fallback = runFallbackAttempt({
            run,
            provider: "fixture-provider",
            model: "fixture-model",
            attempts: [],
            attempt: 1,
            total: 2,
          });
          if (primary === "provider") {
            await expect(fallback).resolves.toMatchObject({ error: primaryError });
            expect(resolveModelFallbackError(failure)).toEqual({
              kind: "failover",
              error: primaryError,
            });
          } else {
            await expect(fallback).rejects.toBe(primaryError);
          }
          expect(run).toHaveBeenCalledOnce();
        } else if (closeFails) {
          await expect(operation).rejects.toBe(cleanupError);
        } else {
          await operation;
        }
      } finally {
        uninstall();
        inputTurn.preparedRunAdmission.close();
      }

      expect(inputTurn.prompt).toBe(originalPrompt);
      expect(inputTurn.transcriptPrompt).toBe("Canonical transcript request");
      expect(closeComputer).toHaveBeenCalledTimes(nodeDeviceId ? 1 : 0);
      expect(order).toEqual([
        "local",
        ...(nodeDeviceId ? ["close"] : []),
        "quiesce",
        "reconcile",
        "resume",
      ]);
      expect(launchTurn).not.toHaveBeenCalled();
      expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      const placement = placements.get(SESSION_ID);
      expect([placement?.state, placement?.turnClaim]).toEqual(["active", null]);
      if (retainedNodeAuthority) {
        expect(retainedNodeAuthority).toThrow("no longer current");
      }
    },
  );
});
