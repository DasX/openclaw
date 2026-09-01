import { afterEach, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { withPreparedEmbeddedRunToolAuthority } from "../agents/harness/tool-authority.runtime.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import { prepareTalkClientControlAuthority } from "./talk-client-agent-consult.js";
import { resolveTalkAgentConsultAuthority } from "./talk-client-gateway-control.js";
import { prepareTalkSessionTarget } from "./talk-session-target.js";

vi.mock("../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  vi.restoreAllMocks();
});

// Normal reply preparation, not a fabricated FollowupRun/hash, supplies this baseline.
it("steers a GA chat-owned Talk run with current authenticated ingress, not direct-voice capabilities", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = withFullRuntimeReplyConfig({
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: {
          skipBootstrap: true,
          model: { primary: "mock-openai/gpt-5.6-luna" },
          models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
        },
      },
      plugins: { enabled: false },
    });
    await state.writeConfig(config);
    const client = sharingPolicyClient({ deviceId: "caller-device", scopes: ["operator.admin"] });
    client.connect.caps = ["tool-events", "task-suggestions"];
    const sessionTarget = prepareTalkSessionTarget(config, "agent:main:main");
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
    const queueMessage = vi.fn(async () => undefined);
    let executionError: unknown;
    vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
      try {
        if (
          !params.preparedRunAdmission ||
          !params.replyOperation ||
          !params.provider ||
          !params.model ||
          !params.sessionFile
        ) {
          throw new Error("Missing real reply admission");
        }
        const operation = params.replyOperation;
        const admittedRunContext = await params.preparedRunAdmission.admit(
          "embedded",
          "talk-chat-test",
        );
        return await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: params.replyOperation },
          {
            ...params,
            provider: params.provider,
            modelId: params.model,
            sessionFile: params.sessionFile,
          },
          undefined,
          async (prepared) => {
            const handle = {
              ...createEmbeddedRunHandle({
                runId: params.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                queueMessage,
              }),
              kind: "embedded" as const,
              cancel: () => {},
            };
            operation.attachBackend(handle);
            operation.setPhase("running");
            setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
            const overlay = (source: "reply" | "attempt", current = authority) =>
              prepareTalkClientControlAuthority({
                config,
                sessionTarget,
                authority: current,
                source,
                agentRuntime: createPluginRuntime().agent,
              });
            const steer = (incoming: ReturnType<typeof overlay>) =>
              queueEmbeddedAgentMessageWithOutcomeAsync(
                params.sessionId,
                "use the release branch",
                {
                  isInboundUserMessage: true,
                  toolAuthorityOverlay: incoming,
                  taskSuggestionDeliveryMode: undefined,
                },
              );
            try {
              // This is the old direct-voice overlay; it truthfully lacks GA trace/reviewer/client facts.
              await expect(steer(overlay("attempt"))).resolves.toMatchObject({
                queued: false,
                reason: "tool_authority_mismatch",
              });
              await expect(steer(overlay("reply"))).resolves.toMatchObject({ queued: true });
              const weaker = sharingPolicyClient({
                deviceId: "caller-device",
                scopes: ["operator.read"],
              });
              await expect(
                steer(
                  overlay("reply", resolveTalkAgentConsultAuthority(weaker.connect.scopes, weaker)),
                ),
              ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
              expect(queueMessage).toHaveBeenCalledOnce();
            } finally {
              clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
            }
            return { payloads: [{ text: "Original GA task completed." }], meta: { durationMs: 1 } };
          },
        );
      } catch (error) {
        executionError = error;
        throw error;
      }
    });
    const result = await getReplyFromConfig(
      finalizeInboundContext({
        ...authority.replyCaller,
        AgentId: "main",
        SessionKey: sessionTarget.canonicalKey,
        Body: "Check the repository",
        BodyForAgent: "Check the repository",
        CommandAuthorized: false,
        CommandInterpretationSuppressed: true,
        InputProvenance: { kind: "internal_system", sourceTool: "openclaw_agent_consult" },
      }),
      { toolsAllow: authority.toolsAllow },
      config,
    );
    if (executionError) {
      throw new Error("GA reply test execution failed", { cause: executionError });
    }
    expect([result].flat()).toContainEqual(
      expect.objectContaining({ text: "Original GA task completed." }),
    );
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });
});
