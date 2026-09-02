import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { markBackgrounded } from "../../agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../../agents/bash-process-registry.test-support.js";
import { runExecProcess } from "../../agents/bash-tools.exec-runtime.js";
import { createProcessTool } from "../../agents/bash-tools.process.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { claimAgentSessionWriter } from "../../agents/embedded-agent-runner/run/session-bootstrap.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntrySync,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  getOwnedSessionTranscriptWriterFence,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
  type OwnedSessionTranscriptWriteContext,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../dispatch.js";
import { scheduleFollowupDrainAfterReplyOperationClear } from "./agent-runner-core.js";
import { createDispatchReplyOperationCoordinator } from "./dispatch-from-config.lifecycle.js";
import { finalizeInboundContext } from "./inbound-context.js";
import {
  admitFollowupRunLifecycle,
  clearSessionQueues,
  completeFollowupRunLifecycle,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  type FollowupRun,
} from "./queue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import * as handoff from "./session-event-handoff.js";

const boundary = vi.hoisted(() => ({ dispatch: vi.fn(), route: vi.fn() }));
vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: boundary.dispatch,
}));
vi.mock("./route-reply.js", () => ({
  isRoutableChannel: () => true,
  routeReply: boundary.route,
}));

type Dispatch = Parameters<typeof dispatchInboundMessageWithRoutedChannelDispatcher>[0];
type Target = { agentId: string; sessionId: string; sessionKey: string; storePath: string };
const key = "agent:main:handoff-scope";

async function openWriter(target: Target, cfg: OpenClawConfig, runId: string) {
  const admission = prepareSystemAgentRunAdmission(cfg, runId, target.agentId, "handoff-test");
  const admittedRunContext = await admission.admit("embedded");
  const fence = await claimAgentSessionWriter({
    ...target,
    sessionTarget: target,
    sessionFile: key,
    workspaceDir: path.dirname(target.storePath),
    config: cfg,
    prompt: "local ownership proof",
    timeoutMs: 10_000,
    runId,
    admittedRunContext,
  });
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
    runId,
    sessionId: target.sessionId,
  });
  const failures: string[] = [];
  const context: OwnedSessionTranscriptWriteContext = {
    sessionTarget: { ...target, ...fence },
    assertCommitAllowed: resolveAdmittedRunActiveAssertion(admittedRunContext),
    withTranscriptWrite: async (write) => {
      try {
        return await lifecycle.withTranscriptWrite(write);
      } catch (error) {
        failures.push(String(error));
        throw error;
      }
    },
  };
  return {
    failures,
    run: <T>(fn: () => Promise<T>) => withOwnedSessionTranscriptWrites(context, fn),
    close: async () => {
      admission.close();
      await lifecycle.dispose();
    },
  };
}

afterEach(() => {
  clearSessionQueues([key]);
  testing.resetReplyRunRegistry();
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  boundary.dispatch.mockReset();
  boundary.route.mockReset();
});

describe("session-event transcript ownership boundary", () => {
  it.each(["direct", "queued", "polled"] as const)(
    "does not borrow a completed exec producer's writer (%s)",
    async (mode) => {
      await withOpenClawTestState({ label: "handoff-transcript-scope" }, async (state) => {
        const target: Target = {
          agentId: "main",
          sessionId: "handoff-session",
          sessionKey: key,
          storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        };
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { default: true } } },
          session: { store: target.storePath },
        };
        setRuntimeConfigSnapshot(cfg);
        replaceSessionEntrySync(target, {
          sessionId: target.sessionId,
          updatedAt: Date.now(),
          lifecycleRevision: "original-lifecycle",
          delivery: normalizeSessionDeliveryState({
            context: {
              channel: "telegram",
              to: "original-target",
              accountId: "account",
              threadId: "7",
            },
          }),
        });
        const root = tryBeginGatewayRootWorkAdmission("ws:agent");
        expect(root).not.toBeNull();
        const producer = await root!.run(() => openWriter(target, cfg, "producer-writer"));
        const completionScopes: { globalClosed: boolean; inheritedClosed: boolean }[] = [];
        const deliveryEntered = createDeferredCore();
        const releaseDelivery = createDeferredCore();
        const owners = [producer];
        const admitted = createDeferredCore();
        const admissionErrors: unknown[] = [];
        const drained = createDeferredCore();
        const entryFences: ReturnType<typeof getOwnedSessionTranscriptWriterFence>[] = [];
        const eventOperations: unknown[] = [];
        const dispatchers: ReturnType<typeof createReplyDispatcher>[] = [];
        const event = vi.spyOn(handoff, "enqueueSessionEventForHost");
        boundary.route.mockImplementation(async (params) => {
          params.assertCurrent();
          expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
          deliveryEntered.resolve();
          await releaseDelivery.promise;
          params.assertCurrent();
          return { ok: true, delivered: true };
        });

        // The adapter keeps the real pre-dispatch coordinator before the queue
        // decision. Only downstream model/transport work is simulated; admission,
        // queue drains, direct input persistence and transcript guards stay real.
        boundary.dispatch.mockImplementation(async (dispatch: Dispatch) => {
          const opts = dispatch.replyOptions!;
          entryFences.push(getOwnedSessionTranscriptWriterFence({ sessionTarget: target }));
          expect(opts.toolsAllow).toEqual(["read"]);
          const dispatcher = createReplyDispatcher(dispatch.dispatcherOptions);
          dispatchers.push(dispatcher);
          const coordinator = createDispatchReplyOperationCoordinator({
            agentId: target.agentId,
            cfg,
            ctx: finalizeInboundContext(dispatch.ctx),
            dispatcher,
            dispatchOperationSessionKey: key,
            operationSessionStoreEntry: {
              entry: loadSessionEntry(target),
              storePath: target.storePath,
            },
            replyOptions: opts,
            resolveOperationExpectedSessionId: () => target.sessionId,
          });
          try {
            expect(await coordinator.ensureDispatchReplyOperation("pre_dispatch")).toEqual({
              status: "ready",
            });
          } catch (error) {
            admissionErrors.push(error);
            admitted.resolve();
            throw error;
          }
          const directOperation = coordinator.getDispatchReplyOperation();
          const execute = async (queued?: FollowupRun) => {
            const result =
              directOperation && !queued
                ? { status: "owned" as const, operation: directOperation }
                : await admitReplyTurn({
                    ...target,
                    expectedSessionId: target.sessionId,
                    kind: "queued_followup",
                    resetTriggered: false,
                    upstreamAbortSignal: opts.abortSignal,
                  });
            if (result.status !== "owned") {
              if (!queued) {
                throw new Error(`event admission ${result.reason}`);
              }
              expect(result.reason).toBe("aborted");
              completeFollowupRunLifecycle(queued);
              drained.resolve();
              return;
            }
            const operation = result.operation;
            eventOperations.push(operation);
            try {
              if (queued) {
                await admitFollowupRunLifecycle(queued);
              }
              const recorder = createUserTurnTranscriptRecorder({
                input: {
                  text: String(dispatch.ctx.Body),
                  provenance: { kind: "internal_system", sourceTool: "exec" },
                },
                target: () => ({ ...target, sessionEntry: loadSessionEntry(target), config: cfg }),
                errorContext: "handoff boundary user turn",
              });
              const recovery = createReplyRestartRecoveryClaimController({
                ...target,
                lifecycleGeneration: operation.lifecycleGeneration,
                getEntry: () => loadSessionEntry(target),
                getSessionId: () => operation.sessionId,
                isRestartAbort: () => operation.abortSignal.aborted,
                resolveDeliveryContext: () => undefined,
                resolveUserTurnTarget: ({ entry }) => ({
                  ...target,
                  sessionEntry: entry,
                  config: cfg,
                }),
                setEntry: () => {},
              });
              // The queued runner does not call direct recovery admission. Its
              // input is persisted later under the newly established writer.
              if (!queued) {
                await recovery.admitUserTurn(recorder);
                expect(recorder.hasPersisted()).toBe(true);
              }
              const writer = await openWriter(target, cfg, "event-writer");
              owners.push(writer);
              if (!queued) {
                await opts.turnAdoptionLifecycle!.onAdopted();
              }
              await opts.internalEventExecution!.beforeStart?.();
              opts.internalEventExecution!.onStarted("event-writer");
              await writer.run(async () => {
                if (queued) {
                  await recorder.persistApproved();
                }
                expect(
                  appendTranscriptMessageSync(target, {
                    message: { role: "assistant", content: "event completed" },
                  }),
                ).toMatchObject({ ok: true });
              });
              await opts.internalEventExecution!.onTerminal("event-writer", "completed");
              if (queued) {
                await opts.onQueuedFollowupReplyBatch!({
                  kind: "queued-followup",
                  runId: "event-writer",
                  originatingChannel: "telegram",
                  payloads: [{ text: "event completed" }],
                });
              } else {
                await dispatch.dispatcherOptions.deliver(
                  { text: "event completed" },
                  { kind: "final" },
                );
              }
            } catch (error) {
              opts.internalEventExecution!.onFailed?.(error);
              if (!queued) {
                throw error;
              }
            } finally {
              if (queued) {
                completeFollowupRunLifecycle(queued);
              }
              operation.complete();
              drained.resolve();
            }
          };
          const foreground = directOperation ? undefined : replyRunRegistry.get(key);
          if (foreground) {
            const queued: FollowupRun = {
              prompt: String(dispatch.ctx.Body),
              messageId: String(dispatch.ctx.MessageSid),
              enqueuedAt: Date.now(),
              turnAdoptionLifecycle: opts.turnAdoptionLifecycle,
              abortSignal: opts.abortSignal,
              run: {
                ...target,
                agentDir: state.agentDir(),
                sessionFile: key,
                workspaceDir: state.workspaceDir,
                config: cfg,
                provider: "openai",
                model: "gpt-5.6-luna",
                timeoutMs: 10_000,
                blockReplyBreak: "message_end",
              },
            };
            expect(
              enqueueFollowupRun(
                key,
                queued,
                { mode: "followup", debounceMs: 0 },
                "message-id",
                execute,
                false,
              ),
            ).toBe(true);
            scheduleFollowupDrainAfterReplyOperationClear({
              operation: foreground,
              queueKey: key,
              runFollowup: execute,
            });
            await coordinator.releasePreDispatchLifecycleAdmission();
            admitted.resolve();
            return { deferredToActiveRun: true };
          }
          admitted.resolve();
          await execute();
          return {};
        });

        let processRun: Awaited<ReturnType<typeof runExecProcess>> | undefined;
        let foreground: ReturnType<typeof createReplyOperation> | undefined;
        let busyRoot: ReturnType<typeof tryBeginGatewayRootWorkAdmission> = null;
        try {
          processRun = await root!.run(() =>
            producer.run(() =>
              withGatewayToolCallerIdentity(
                { agentId: "main", sessionKey: key, sessionEventToolsAllow: ["read"] },
                () =>
                  runExecProcess({
                    command: "release-gated local completion",
                    workdir: state.workspaceDir,
                    env: {},
                    usePty: false,
                    warnings: [],
                    maxOutput: 1_000,
                    pendingMaxOutput: 1_000,
                    timeoutSec: 10,
                    agentId: "main",
                    sessionKey: key,
                    notifyOnExit: true,
                    onSettledBeforeNotify: () => {
                      completionScopes.push({
                        globalClosed: isGatewayWorkAdmissionClosed(),
                        inheritedClosed: isGatewaySubordinateWorkAdmissionClosed(),
                      });
                    },
                    sandbox: {
                      containerName: "local-test",
                      containerWorkdir: state.workspaceDir,
                      workspaceDir: state.workspaceDir,
                      buildExecSpec: async () => ({
                        argv: [
                          process.execPath,
                          "-e",
                          'process.stdin.once("data", () => { process.stdout.write("completion marker\\n"); process.exit(0); });',
                        ],
                        env: {},
                        stdinMode: "pipe-open",
                      }),
                    },
                  }),
              ),
            ),
          );
          markBackgrounded(processRun.session);
          processRun.disableUpdates();
          await producer.close();
          root!.release();
          expect(getActiveGatewayRootWorkCount()).toBe(0);
          await expect(
            producer.run(async () =>
              appendTranscriptMessageSync(target, {
                message: { role: "user", content: "late producer" },
              }),
            ),
          ).rejects.toThrow("admitted run authority is no longer active");

          if (mode !== "direct") {
            busyRoot = tryBeginGatewayRootWorkAdmission("ws:busy-agent");
            expect(busyRoot).not.toBeNull();
            foreground = createReplyOperation({
              sessionKey: key,
              sessionId: target.sessionId,
              turnKind: "visible",
              resetTriggered: false,
            });
            const writer = await openWriter(target, cfg, "foreground-writer");
            owners.push(writer);
            await writer.run(async () => {
              expect(
                appendTranscriptMessageSync(target, {
                  message: { role: "user", content: "foreground active" },
                }),
              ).toMatchObject({ ok: true });
            });
          }
          if (foreground) {
            await updateSessionEntry(
              target,
              () => ({
                delivery: normalizeSessionDeliveryState({
                  context: { channel: "telegram", to: "unrelated-target" },
                }),
              }),
              { skipMaintenance: true },
            );
          }
          const completion = processRun;
          const releaseCompletion = async () => {
            completion.session.stdin!.write("release\n");
            await expect(completion.promise).resolves.toMatchObject({
              status: "completed",
              exitCode: 0,
            });
            await admitted.promise;
            if (foreground) {
              expect(getOwnedSessionTranscriptWriterFence({ sessionTarget: target })).toMatchObject(
                { expectedWriterRunId: "foreground-writer" },
              );
              expect(() =>
                appendTranscriptMessageSync(
                  { ...target, sessionId: "wrong-session" },
                  { message: { role: "user", content: "wrong target" } },
                ),
              ).toThrow(SessionTranscriptWriterClaimReboundError);
            }
          };
          await (foreground
            ? busyRoot!.run(() => owners[1]!.run(releaseCompletion))
            : releaseCompletion());
          expect(completionScopes).toEqual([{ globalClosed: false, inheritedClosed: true }]);
          expect(event).toHaveBeenCalledOnce();
          const receipt = event.mock.results[0]!.value as handoff.SessionEventReceipt;
          // Surface a real pre-admission rejection instead of timing out on a queue
          // that could never be reached. Both direct and busy paths cross this guard.
          if (admissionErrors.length) {
            expect(await receipt.settled, String(admissionErrors[0])).toMatchObject({
              status: "completed",
              executionStarted: true,
            });
          }
          if (foreground) {
            expect(getFollowupQueueDepth(key)).toBe(1);
            expect(getActiveGatewayRootWorkCount()).toBe(2);
            expect(eventOperations).toEqual([]);
            expect(replyRunRegistry.get(key)).toBe(foreground);
            expect(loadSessionEntry(target)).toMatchObject({
              activeWriterRunId: "foreground-writer",
            });
            expect(foreground.abortSignal.aborted).toBe(false);
            if (mode === "polled") {
              await createProcessTool().execute("poll-completion", {
                action: "poll",
                sessionId: processRun.session.id,
              });
              await expect(receipt.settled).resolves.toMatchObject({
                status: "cancelled",
                executionStarted: false,
              });
            }
            await busyRoot!.run(async () => {
              await owners[1]!.close();
              foreground!.complete();
            });
            busyRoot!.release();
          }
          if (mode === "polled") {
            await vi.waitFor(() => expect(getFollowupQueueDepth(key)).toBe(0));
            expect(eventOperations).toEqual([]);
            expect(boundary.route).not.toHaveBeenCalled();
          } else {
            await deliveryEntered.promise;
            expect(getActiveGatewayRootWorkCount()).toBe(mode === "direct" ? 1 : 2);
            expect(getActiveGatewayRootWorkHolders()).not.toContain("ws:agent");
            releaseDelivery.resolve();
            const outcome = await receipt.settled;
            expect(
              outcome,
              JSON.stringify({ outcome, producerFailures: producer.failures }),
            ).toMatchObject({
              status: "completed",
              executionStarted: true,
              delivered: true,
            });
            await drained.promise;
            expect(eventOperations).toHaveLength(1);
            expect(eventOperations[0]).not.toBe(foreground);
            expect(loadSessionEntry(target)).toMatchObject({
              activeWriterRunId: "event-writer",
              lifecycleRevision: "original-lifecycle",
            });
            expect(boundary.route).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                channel: "telegram",
                to: "original-target",
                accountId: "account",
                threadId: "7",
              }),
            );
            expect(
              loadTranscriptEventsSync(target).some((entry) =>
                JSON.stringify(entry).includes("event completed"),
              ),
            ).toBe(true);
          }
          const currentWriter = owners.at(-1)!;
          const transcriptBeforeClose = loadTranscriptEventsSync(target);
          await currentWriter.close();
          await expect(
            currentWriter.run(async () =>
              appendTranscriptMessageSync(target, {
                message: { role: "user", content: "late current writer" },
              }),
            ),
          ).rejects.toThrow("admitted run authority is no longer active");
          expect(loadTranscriptEventsSync(target)).toEqual(transcriptBeforeClose);
          expect(peekSystemEventEntries(key)).toEqual([]);
          expect(entryFences).toEqual([undefined]);
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        } finally {
          releaseDelivery.resolve();
          root?.release();
          busyRoot?.release();
          processRun?.kill();
          await processRun?.promise;
          clearSessionQueues([key]);
          for (const dispatcher of dispatchers) {
            dispatcher.markComplete();
          }
          foreground?.complete();
          for (const owner of owners) {
            await owner.close();
          }
        }
      });
    },
  );
});
