import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { readSessionTranscriptMessageEvents } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { flushClientVoiceSessionWrites } from "../../talk/client-voice-session.js";
import {
  AGENT_ID,
  SESSION_ID,
  SESSION_KEY,
  connectNativeSession,
  installNativePluginTestHooks,
  nativeDelegation,
  requireString,
  talkEventTypes,
  upstream,
  withParkedNativeTask,
  withNativePlugin,
} from "./talk-client-native-control.test-support.js";

function nativeTranscript(text: string) {
  return { type: "turn.done", turn: { role: "user", transcript: text } };
}

function spokenMessages(frames: string[]): string[] {
  return frames.flatMap((frame) => {
    const event: unknown = JSON.parse(frame);
    if (!isRecord(event) || event.channel !== "speakable" || !Array.isArray(event.content)) {
      return [];
    }
    return event.content.flatMap((content: unknown) =>
      isRecord(content) && content.type === "input_text" && typeof content.text === "string"
        ? [content.text]
        : [],
    );
  });
}

async function flushNativeTranscript(result: Record<string, unknown>) {
  await flushClientVoiceSessionWrites({
    agentId: AGENT_ID,
    voiceSessionId: requireString(result, "voiceSessionId"),
  });
  await nextEventLoopTurn();
}

function expectOriginalResult(frames: string[]) {
  expect(frames.map((frame): unknown => JSON.parse(frame))).toContainEqual({
    type: "delegation.context.append",
    delegation_item_id: "original-task",
    channel: "speakable",
    content: [{ type: "input_text", text: "Original task completed normally." }],
  });
}

const activeControls = [
  {
    mode: "steering",
    text: "use the release branch instead",
    acknowledgment: "Got it. I steered the active run.",
  },
  {
    mode: "followup",
    text: "after that check tests",
    acknowledgment: "Queued that follow-up for the active OpenClaw run.",
  },
] as const;

describe("native Talk action ownership through public plugin registration", () => {
  installNativePluginTestHooks();

  it.each([
    ["replacement", "cancel"],
    ["idle", "cancel"],
    ["queued replacement", "steer"],
  ] as const)(
    "does not retarget %s during control readiness or FIFO wait (%s)",
    async (transition, mode) => {
      await withParkedNativeTask(
        async ({ socket, activeRun, chatAbortControllers, abortOwned, queueMessage }) => {
          const entry = chatAbortControllers.get(activeRun.runId);
          if (!entry) {
            throw new Error("Missing original registration");
          }
          if (transition === "idle") {
            chatAbortControllers.delete(activeRun.runId);
          }
          const before = socket.sent.length;
          const queued = transition === "queued replacement";
          if (queued) {
            socket.serverEvent(nativeDelegation("prefix-control", "cancel"));
          }
          socket.serverEvent(
            nativeDelegation(
              "captured-control",
              mode === "cancel" ? "cancel" : "use the release branch instead",
            ),
          );
          // Same call and even the same correlation ID cannot adopt a new registration.
          chatAbortControllers.set(activeRun.runId, { ...entry });
          await vi.waitFor(() =>
            expect(spokenMessages(socket.sent.slice(before))).toEqual([
              ...(queued
                ? [expect.stringContaining("There is no active OpenClaw run to cancel.")]
                : []),
              expect.stringContaining(`There is no active OpenClaw run to ${mode}.`),
            ]),
          );
          expect(abortOwned).not.toHaveBeenCalled();
          expect(queueMessage).not.toHaveBeenCalled();
          expect(activeRun.abortSignal.aborted).toBe(false);
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        },
      );
    },
  );

  it("consumes a startup control with a visible refusal before any backend publishes", async () => {
    const release = createDeferredCore();
    let signal: AbortSignal | undefined;
    upstream.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      signal = params.abortSignal;
      await release.promise;
      return { payloads: [{ text: "Original task completed normally." }], meta: { durationMs: 0 } };
    });
    await withNativePlugin(async (fixture) => {
      const { socket } = await connectNativeSession(fixture);
      try {
        socket.serverEvent(nativeDelegation("original-task", "Keep working."));
        await vi.waitFor(() => expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce());
        const before = socket.sent.length;
        socket.serverEvent(nativeDelegation("startup-control", "use the release branch instead"));
        await vi.waitFor(() =>
          expect(spokenMessages(socket.sent.slice(before))).toEqual([
            expect.stringContaining("There is no active OpenClaw run to steer."),
          ]),
        );
        expect(signal?.aborted).toBe(false);
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        release.resolve();
        await vi.waitFor(() => expectOriginalResult(socket.sent));
        expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
      } finally {
        release.resolve();
        await Promise.allSettled(
          upstream.runEmbeddedAgent.mock.results.flatMap((result) =>
            result.type === "return" ? [result.value] : [],
          ),
        );
      }
    });
  });

  it("admits public steering with current authenticated caller authority", async () => {
    await withParkedNativeTask(
      async ({ invoke, socket, activeRun, queueMessage, abortOwned, settleBackend }) => {
        const result = await invoke("talk.client.steer", {
          sessionKey: SESSION_KEY,
          text: "use the release branch instead",
          mode: "steer",
        });
        expect(result).toMatchObject({ ok: true, queued: true });
        expect(queueMessage).toHaveBeenCalledOnce();
        expect(abortOwned).not.toHaveBeenCalled();
        expect(activeRun.abortSignal.aborted).toBe(false);
        await settleBackend();
        await vi.waitFor(() => expectOriginalResult(socket.sent));
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
      },
    );
  });

  it.each(activeControls)(
    "keeps $mode on retained work after same-call transport replacement",
    async ({ text, acknowledgment }) => {
      await withParkedNativeTask(
        async ({
          create,
          offer,
          result,
          socket,
          activeRun,
          queueMessage,
          abortOwned,
          settleBackend,
        }) => {
          const replacement = await connectNativeSession(
            { create, offer },
            true,
            requireString(result, "voiceSessionId"),
          );
          expect(replacement.result.voiceSessionId).toBe(result.voiceSessionId);
          await vi.waitFor(() => expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED));
          replacement.socket.serverEvent(nativeDelegation("replacement-control", text));
          await vi.waitFor(() =>
            expect({
              deliveries: queueMessage.mock.calls.length,
              taskStarts: upstream.runEmbeddedAgent.mock.calls.length,
              originalRunAborted: activeRun.abortSignal.aborted,
            }).toEqual({ deliveries: 1, taskStarts: 1, originalRunAborted: false }),
          );
          replacement.socket.serverEvent(nativeTranscript(text));
          await flushNativeTranscript(replacement.result);
          expect(spokenMessages(replacement.socket.sent)).toEqual([
            expect.stringContaining(acknowledgment),
          ]);
          expect(abortOwned).not.toHaveBeenCalled();
          await settleBackend();
          expect(activeRun.abortSignal.aborted).toBe(false);
          expect(queueMessage).toHaveBeenCalledOnce();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        },
      );
    },
  );

  // Unlike classifier tests, these pairs reach the provider's replacement policy and real run queue.
  describe.each(activeControls)("active $mode", ({ text, acknowledgment }) => {
    it.each(["transcript-first", "delegation-first"] as const)(
      "delivers once without replacing the original task (%s)",
      async (order) => {
        await withParkedNativeTask(
          async ({ socket, result, activeRun, queueMessage, abortOwned, settleBackend }) => {
            const beforeControl = socket.sent.length;
            if (order === "transcript-first") {
              socket.serverEvent(nativeTranscript(text));
              // Persistence can finish before delegation; no control acknowledgment is required.
              await flushNativeTranscript(result);
              socket.serverEvent(nativeDelegation("active-control", text));
            } else {
              socket.serverEvent(nativeDelegation("active-control", text));
              socket.serverEvent(nativeTranscript(text));
            }
            await flushNativeTranscript(result);
            await vi.waitFor(() =>
              expect({
                deliveries: queueMessage.mock.calls.length,
                originalRunAborted: activeRun.abortSignal.aborted,
                taskStarts: upstream.runEmbeddedAgent.mock.calls.length,
              }).toEqual({ deliveries: 1, originalRunAborted: false, taskStarts: 1 }),
            );
            expect(queueMessage.mock.calls[0]?.[0]).toContain(text);
            expect(activeRun.abortSignal.aborted).toBe(false);
            expect(abortOwned).not.toHaveBeenCalled();
            expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
            await vi.waitFor(() =>
              expect(spokenMessages(socket.sent.slice(beforeControl))).toEqual([
                expect.stringContaining(acknowledgment),
              ]),
            );

            await settleBackend();
            await vi.waitFor(() => expectOriginalResult(socket.sent));
            expect(queueMessage).toHaveBeenCalledOnce();
            expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
            expect(activeRun.abortSignal.aborted).toBe(false);
            expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
          },
        );
      },
    );
  });

  // Both ordinary requests match the broad control classifier; neither may be suppressed or self-steered.
  it.each(["Check the weather.", "Also summarize the report."])(
    "admits idle task %s once without steering it when final ASR arrives later",
    async (text) => {
      await withParkedNativeTask(
        async ({ socket, result, activeRun, queueMessage, abortOwned, settleBackend }) => {
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(activeRun.prompt).toContain(text);
          const beforeTranscript = socket.sent.length;
          socket.serverEvent(nativeTranscript(text));
          await flushNativeTranscript(result);
          expect(
            spokenMessages(socket.sent.slice(beforeTranscript)),
            "persisting final ASR must not issue a steering result or refusal",
          ).toEqual([]);
          expect(queueMessage).not.toHaveBeenCalled();
          expect(abortOwned).not.toHaveBeenCalled();
          expect(activeRun.abortSignal.aborted).toBe(false);
          expect(
            readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
          ).toMatchObject([
            {
              event: {
                message: {
                  role: "user",
                  content: [{ type: "text", text }],
                },
              },
            },
          ]);
          await settleBackend();
          await vi.waitFor(() => expectOriginalResult(socket.sent));
          expect(queueMessage).not.toHaveBeenCalled();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        },
        text,
      );
    },
  );

  // A same-turn test misses the state transition between a persisted transcript and its delegation.
  it.each(activeControls)(
    "makes one current-state decision for $mode delegated after original settlement",
    async ({ text }) => {
      await withParkedNativeTask(
        async ({ socket, result, activeRun, queueMessage, abortOwned, settleBackend }) => {
          const beforeTranscript = socket.sent.length;
          socket.serverEvent(nativeTranscript(text));
          await flushNativeTranscript(result);
          expect.soft(queueMessage, "final ASR must not steer the old task").not.toHaveBeenCalled();
          expect
            .soft(
              spokenMessages(socket.sent.slice(beforeTranscript)),
              "final ASR must not attempt control before delegation",
            )
            .toEqual([]);
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          await settleBackend();
          await vi.waitFor(() => expectOriginalResult(socket.sent));
          expect(activeRun.abortSignal.aborted).toBe(false);

          socket.serverEvent(nativeDelegation("after-settlement", text));
          await vi.waitFor(() => expect(upstream.runEmbeddedAgent).toHaveBeenCalledTimes(2));
          await vi.waitFor(() =>
            expect(socket.sent.map((frame): unknown => JSON.parse(frame))).toContainEqual({
              type: "delegation.context.append",
              delegation_item_id: "after-settlement",
              channel: "speakable",
              content: [{ type: "input_text", text: "Subsequent task completed." }],
            }),
          );
          expect(upstream.runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain(text);
          expect(
            queueMessage,
            "one input must not both steer old work and start new work",
          ).not.toHaveBeenCalled();
          expect(abortOwned).not.toHaveBeenCalled();
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        },
      );
    },
  );

  // The real queue yields on readiness: one synchronous burst fills it without a blocker seam.
  it("speaks a bounded refusal at control capacity and accepts a fresh cancel after draining", async () => {
    await withParkedNativeTask(
      async ({
        socket,
        result,
        activeRun,
        queueMessage,
        abortOwned,
        broadcast,
        chatAbortControllers,
      }) => {
        const beforeBurst = socket.sent.length;
        for (let index = 0; index < 9; index += 1) {
          socket.serverEvent(nativeTranscript("Status?"));
          socket.serverEvent(nativeDelegation(`status-${index}`, "Status?"));
        }
        socket.serverEvent(nativeTranscript("cancel"));
        socket.serverEvent(nativeDelegation("overflow-cancel", "cancel"));
        await flushNativeTranscript(result);
        const statusReply = "OpenClaw is working on the current voice request.";
        await vi.waitFor(() =>
          expect(
            spokenMessages(socket.sent.slice(beforeBurst)).filter((message) =>
              message.includes(statusReply),
            ),
          ).toHaveLength(9),
        );
        const refusals = spokenMessages(socket.sent.slice(beforeBurst)).filter(
          (message) => !message.includes(statusReply),
        );
        // Keep going after a missing refusal so recovery independently catches a permanently sealed queue.
        expect
          .soft(refusals, "the unaccepted cancel needs an explicit spoken refusal")
          .toEqual([
            expect.stringMatching(
              /(?:queue|control).*(?:full|busy|capacity)|(?:full|busy|capacity).*(?:queue|control)/i,
            ),
          ]);
        for (const refusal of refusals) {
          expect(Buffer.byteLength(refusal, "utf8")).toBeLessThanOrEqual(500);
        }
        expect(socket.sent.slice(beforeBurst).join("\n")).not.toContain(
          "Cancelled the active OpenClaw run.",
        );
        expect(queueMessage).not.toHaveBeenCalled();
        expect(abortOwned).not.toHaveBeenCalled();
        expect(activeRun.abortSignal.aborted).toBe(false);
        expect(chatAbortControllers.has(activeRun.runId)).toBe(true);
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        expect(talkEventTypes(broadcast)).not.toContain("session.error");

        const beforeRecovery = socket.sent.length;
        socket.serverEvent(nativeTranscript("cancel"));
        socket.serverEvent(nativeDelegation("fresh-cancel", "cancel"));
        await vi.waitFor(() => expect(abortOwned).toHaveBeenCalledOnce());
        await vi.waitFor(() =>
          expect(spokenMessages(socket.sent.slice(beforeRecovery))).toEqual([
            expect.stringContaining("Cancelled the active OpenClaw run."),
          ]),
        );
        await flushNativeTranscript(result);
        expect(activeRun.abortSignal.aborted).toBe(true);
        expect(queueMessage).not.toHaveBeenCalled();
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        expect(talkEventTypes(broadcast)).not.toContain("session.error");
      },
    );
  });
});
