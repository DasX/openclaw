import { describe, expect, it } from "vitest";
import { markCodeModeControlTool } from "../../agents/code-mode-control-tools.js";
import { buildToolSearchRunPlan } from "../../agents/embedded-agent-runner/run/attempt-tool-search-run-plan.js";
import { createStubTool } from "../../agents/test-helpers/agent-tool-stubs.js";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import {
  buildEmptyExplicitToolAllowlistError,
  collectExplicitToolAllowlistSources,
} from "../../agents/tool-allowlist-guard.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("Code Mode fallback without allowed tools", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("fails the cron run when a fallback only exposes the Code Mode exec bridge", async () => {
    runEmbeddedAgentMock.mockRejectedValueOnce(new Error("primary quota exhausted"));
    // Model the candidate's resolved tool surface using the real callable plan
    // and allowlist guard. No model request or external tool call is needed.
    runEmbeddedAgentMock.mockImplementationOnce(async (candidate: { toolsAllow?: string[] }) => {
      const sources = collectExplicitToolAllowlistSources([
        {
          label: "runtime toolsAllow",
          allow: candidate.toolsAllow,
          enforceWhenToolsDisabled: true,
        },
      ]);
      const toolPlan = buildToolSearchRunPlan({
        visibleTools: ["exec", "wait"].map((name) => markCodeModeControlTool(createStubTool(name))),
        uncompactedTools: [],
        clientToolsCataloged: true,
        catalogToolCount: 0,
        controlsEnabled: true,
        controlNames: ["exec", "wait"],
        explicitAllowlistSources: sources,
      });
      const error = buildEmptyExplicitToolAllowlistError({
        sources,
        hasCallableTools: toolPlan.hasCallableTools,
        toolsEnabled: true,
      });
      if (error) {
        throw error;
      }
      return { payloads: [{ text: "The task could not be performed." }], meta: { agentMeta: {} } };
    });
    runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
      await expect(runInitialModelFallbackAttempt(params)).rejects.toThrow(
        "primary quota exhausted",
      );
      const result = await runFallbackModelAttempt(
        params,
        "google",
        "gemini-3.1-flash-lite",
        "rate_limit",
      );
      return { result, provider: "google", model: "gemini-3.1-flash-lite", attempts: [] };
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({
          delivery: { mode: "none" },
          payload: {
            kind: "agentTurn",
            message: "Review the library",
            toolsAllow: ["read", "exec"],
            fallbacks: ["google/gemini-3.1-flash-lite"],
          },
        }),
      }),
    );
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgentMock.mock.calls.map(([candidate]) => candidate.toolsAllow)).toEqual([
      ["read", "exec"],
      ["read", "exec"],
    ]);
    expect(result.status).toBe("error");
    expect(result.error).toContain("No callable tools remain");
    expect(result.diagnostics?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("No callable tools remain"),
        }),
      ]),
    );
  });
});
