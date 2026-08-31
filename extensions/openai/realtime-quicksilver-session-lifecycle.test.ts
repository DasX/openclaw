import type { RealtimeVoiceGatewayControl } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_GPT_LIVE_MODELS } from "./realtime-quicksilver.js";
import {
  createBroker,
  createCallResponse,
  createRequest,
  createResponseHarness,
  emitSideband,
  parseSent,
  FakeSocket,
} from "./realtime-quicksilver.test-helpers.js";

const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

describe("GPT-Live browser session lifecycle", () => {
  it("rejects negotiated native control without the modern host binding before reserving", async () => {
    const { realtime, runAgentConsult } = createBroker();
    try {
      await expect(
        realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: OPENAI_GPT_LIVE_MODELS[0],
            runAgentConsult,
            clientControl: { owner: "gateway" },
            gatewayControl: { bindBridge: vi.fn() },
          },
          { type: "oauth", token: "synthetic-oauth", accountId: "synthetic-account" },
        ),
      ).rejects.toThrow("requires the host control binding");
      expect(realtime.getSessionCounts()).toEqual({
        pending: 0,
        inFlight: 0,
        active: 0,
        reservations: 0,
      });
    } finally {
      await realtime.cleanup();
    }
  });

  it.each(["m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "m=video 9 UDP/TLS/RTP/SAVPF 96"])(
    "rejects negotiated native %s media and closes its owner without upstream work",
    async (media) => {
      const fetchImpl = vi.fn(async () => createCallResponse());
      const { realtime, runAgentConsult } = createBroker({ fetchImpl });
      const notifications: string[] = [];
      try {
        const reservation = await realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: OPENAI_GPT_LIVE_MODELS[0],
            runAgentConsult,
            clientControl: { owner: "gateway" },
            ownerConnId: "native-media-owner",
            gatewayControl: {
              bindBridge: vi.fn(),
              bindControl: vi.fn(),
              onError: () => notifications.push("error"),
              onClose: (reason) => notifications.push(`close:${reason}`),
            },
          },
          { type: "oauth", token: "synthetic-oauth", accountId: "synthetic-account" },
        );
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }
        const response = createResponseHarness();
        await realtime.handler(
          createRequest({ token: reservation.clientSecret, body: `${AUDIO_ONLY_SDP}${media}\r\n` }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(notifications).toEqual(["error", "close:error"]);
        expect(realtime.getSessionCounts()).toEqual({
          pending: 0,
          inFlight: 0,
          active: 0,
          reservations: 0,
        });
      } finally {
        await realtime.cleanup();
      }
    },
  );

  it("counts negotiated native reservations per owner and restores capacity on cancellation", async () => {
    const { realtime, runAgentConsult } = createBroker();
    const reserve = (ownerConnId: string) =>
      realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: OPENAI_GPT_LIVE_MODELS[0],
          runAgentConsult,
          ownerConnId,
          clientControl: { owner: "gateway" },
          gatewayControl: { bindBridge: vi.fn(), bindControl: vi.fn() },
        },
        { type: "oauth", token: "synthetic-oauth", accountId: "synthetic-account" },
      );
    try {
      const first = await reserve("native-owner");
      await reserve("native-owner");
      await expect(reserve("native-owner")).rejects.toThrow(
        "Too many concurrent OpenAI realtime sessions for this client",
      );
      await expect(reserve("other-owner")).resolves.toHaveProperty("transport", "webrtc");
      await realtime.broker.cancelBrowserSession(first);
      await expect(reserve("native-owner")).resolves.toHaveProperty("transport", "webrtc");
    } finally {
      await realtime.cleanup();
    }
  });

  it("binds negotiated session control after attachment and fences every callback on close", async () => {
    const socket = new FakeSocket("manual");
    const { realtime, runAgentConsult } = createBroker({ socketFactory: () => socket });
    const bindBridge = vi.fn();
    const bindControl = vi.fn<NonNullable<RealtimeVoiceGatewayControl["bindControl"]>>();
    const onReady = vi.fn();
    const onTranscript = vi.fn();
    const onEvent = vi.fn();
    const onClose = vi.fn();
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: OPENAI_GPT_LIVE_MODELS[0],
          runAgentConsult,
          ownerConnId: "native-control-owner",
          clientControl: { owner: "gateway" },
          gatewayControl: { bindBridge, bindControl, onReady, onTranscript, onEvent, onClose },
        },
        { type: "oauth", token: "synthetic-oauth", accountId: "synthetic-account" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      const handling = realtime.handler(
        createRequest({
          token: reservation.clientSecret,
          body: AUDIO_ONLY_SDP,
        }),
        response.res,
      );
      await vi.waitFor(() => expect(socket.listenerCount("open")).toBeGreaterThan(0));
      expect(response.end).not.toHaveBeenCalled();
      expect(bindControl).not.toHaveBeenCalled();
      socket.readyState = 1;
      socket.emit("open");
      await handling;
      expect(response.res.statusCode).toBe(200);
      expect(onReady).toHaveBeenCalledOnce();
      expect(bindBridge).not.toHaveBeenCalled();
      const control = bindControl.mock.calls[0]?.[0];
      if (!control?.sendUserMessage) {
        throw new Error("Expected native session text control");
      }
      control.sendUserMessage("Ready for the next task");
      expect(parseSent(socket)).toEqual([
        {
          type: "session.context.append",
          channel: "speakable",
          content: [{ type: "input_text", text: "Ready for the next task" }],
        },
      ]);
      emitSideband(socket, { type: "session.started", session: {} });
      emitSideband(socket, { type: "input_transcript.added", item: { text: "hel" } });
      emitSideband(socket, { type: "turn.done", turn: { role: "user", transcript: "hello" } });
      expect(onReady).toHaveBeenCalledOnce();
      expect(onTranscript.mock.calls).toEqual([
        ["user", "hel", false],
        ["user", "hello", true],
      ]);
      expect(onEvent).toHaveBeenCalledWith({ direction: "server", type: "turn.done" });
      await realtime.broker.cancelBrowserSession(reservation);
      const sentAtClose = socket.sent.length;
      const eventsAtClose = onEvent.mock.calls.length;
      control.sendUserMessage("Late speech");
      emitSideband(socket, { type: "turn.done", turn: { role: "user", transcript: "late" } });
      emitSideband(socket, { type: "session.started", session: {} });
      expect(socket.sent).toHaveLength(sentAtClose);
      expect(onEvent).toHaveBeenCalledTimes(eventsAtClose);
      expect(onTranscript).toHaveBeenCalledTimes(2);
      expect(onReady).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
      expect(realtime.getSessionCounts()).toEqual({
        pending: 0,
        inFlight: 0,
        active: 0,
        reservations: 0,
      });
    } finally {
      await realtime.cleanup();
    }
  });

  it.each([
    {
      name: "socket error",
      trigger: (socket: FakeSocket) => socket.emit("error", new Error("connection lost")),
      failed: true,
    },
    {
      name: "abnormal close",
      trigger: (socket: FakeSocket) => socket.close(1006, "connection lost"),
      failed: true,
    },
    {
      name: "throwing error callback",
      trigger: (socket: FakeSocket) => socket.emit("error", new Error("connection lost")),
      failed: true,
      throwingCallback: "error",
    },
    {
      name: "throwing close callback",
      trigger: (socket: FakeSocket) => socket.emit("error", new Error("connection lost")),
      failed: true,
      throwingCallback: "close",
    },
    {
      name: "close without status",
      trigger: (socket: FakeSocket) => socket.emit("close"),
      failed: true,
    },
    {
      name: "fatal provider error",
      trigger: (socket: FakeSocket) =>
        emitSideband(socket, { type: "error", error: { code: "invalid_token" } }),
      failed: true,
    },
    {
      name: "binary protocol failure",
      trigger: (socket: FakeSocket) => emitSideband(socket, { unexpected: true }, true),
      failed: true,
    },
    {
      name: "normal close",
      trigger: (socket: FakeSocket) => socket.close(1000, "complete"),
      failed: false,
    },
  ])(
    "reports $name once and releases the active browser owner",
    async ({ trigger, failed, throwingCallback }) => {
      const { realtime, sockets, runAgentConsult } = createBroker();
      const notifications: string[] = [];
      const onError = vi.fn(() => {
        notifications.push("error");
        void realtime.broker.cancelBrowserSession(reservation);
        if (throwingCallback === "error") {
          throw new Error("host error callback failed");
        }
      });
      const onClose = vi.fn((reason: string) => {
        notifications.push(`close:${reason}`);
        if (throwingCallback === "close") {
          throw new Error("host close callback failed");
        }
      });
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-test",
          runAgentConsult,
          gatewayControl: { bindBridge: vi.fn(), onError, onClose },
        },
        { type: "api-key", token: "platform-key" },
      );
      try {
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }
        await realtime.handler(
          createRequest({ token: reservation.clientSecret }),
          createResponseHarness().res,
        );
        const socket = sockets[0];
        if (!socket) {
          throw new Error("Expected sideband socket");
        }
        trigger(socket);
        expect(socket.closed).toBe(true);
        expect(realtime.getSessionCounts()).toEqual({
          pending: 0,
          inFlight: 0,
          active: 0,
          reservations: 0,
        });
        await realtime.cleanup();
        socket.emit("error", new Error("late socket error"));
        socket.emit("close", 1006, Buffer.from("late close"));
        emitSideband(socket, {
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id: "late",
            content: [{ type: "input_text", text: "must not run" }],
          },
        });

        expect(notifications).toEqual(failed ? ["error", "close:error"] : ["close:completed"]);
        expect(onError).toHaveBeenCalledTimes(failed ? 1 : 0);
        expect(onClose).toHaveBeenCalledOnce();
        expect(runAgentConsult).not.toHaveBeenCalled();
      } finally {
        await realtime.cleanup();
      }
    },
  );

  it("releases browser transport while accepted delegation work finishes without late delivery", async () => {
    let finishConsult!: (value: { text: string }) => void;
    let consultSignal: AbortSignal | undefined;
    const result = new Promise<{ text: string }>((resolve) => {
      finishConsult = resolve;
    });
    const runAgentConsult = vi.fn(async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
      consultSignal = signal;
      return await result;
    });
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-test", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      const delegation = {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "accepted-delegation",
          content: [{ type: "input_text", text: "Finish this task" }],
        },
      };
      emitSideband(socket, delegation);
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());

      await realtime.broker.cancelBrowserSession(reservation);
      expect(socket.closed).toBe(true);
      expect(realtime.getSessionCounts()).toEqual({
        pending: 0,
        inFlight: 0,
        active: 0,
        reservations: 0,
      });
      expect(consultSignal?.aborted).toBe(false);
      emitSideband(socket, { ...delegation, item: { ...delegation.item, id: "late-delegation" } });
      finishConsult({ text: "Finished after browser close" });
      await result;
      await Promise.resolve();
      expect(runAgentConsult).toHaveBeenCalledOnce();
      expect(socket.sent.some((payload) => payload.includes("Finished after browser close"))).toBe(
        false,
      );
    } finally {
      finishConsult({ text: "Finished" });
      await realtime.cleanup();
    }
  });
});
