import { describe, expect, it } from "vitest";
import {
  isStaleGatewayAgentRuntimeIdentityRejection,
  isStaleGatewayNodeInvokeTurnSourceRejection,
} from "./gateway-transport-errors.js";

function requestError(message: string, details?: Record<string, unknown>): Error {
  const error = new Error(message);
  error.name = "GatewayClientRequestError";
  return Object.assign(error, { gatewayCode: "INVALID_REQUEST", details });
}

describe("stale gateway rejection probes", () => {
  // These probes recognize an older Gateway rejecting a field this build just sent.
  // The wording belongs to the peer's build, so both delimiters must keep matching.
  it.each([
    ["legacy", "'"],
    ["current", "`"],
  ])("detects an %s connect rejection of the runtime identity field", (_label, quote) => {
    const error = requestError(
      `invalid connect params: at /auth: unexpected property ${quote}agentRuntimeIdentityToken${quote}`,
    );

    expect(isStaleGatewayAgentRuntimeIdentityRejection(error)).toBe(true);
  });

  it.each([
    ["legacy", "'"],
    ["current", "`"],
  ])("detects an %s node.invoke rejection of a turn-source field", (_label, quote) => {
    const error = requestError(
      `invalid node.invoke params: at root: unexpected property ${quote}turnSourceChannel${quote}`,
      { nodeCommandDispatched: false },
    );

    expect(isStaleGatewayNodeInvokeTurnSourceRejection(error)).toBe(true);
  });

  it("does not treat an unrelated rejected property as a stale gateway", () => {
    expect(
      isStaleGatewayAgentRuntimeIdentityRejection(
        requestError("invalid connect params: at /auth: unexpected property `somethingElse`"),
      ),
    ).toBe(false);
    expect(
      isStaleGatewayNodeInvokeTurnSourceRejection(
        requestError("invalid node.invoke params: at root: unexpected property `somethingElse`", {
          nodeCommandDispatched: false,
        }),
      ),
    ).toBe(false);
  });

  it("refuses a node.invoke retry without explicit pre-dispatch provenance", () => {
    expect(
      isStaleGatewayNodeInvokeTurnSourceRejection(
        requestError(
          "invalid node.invoke params: at root: unexpected property `turnSourceChannel`",
        ),
      ),
    ).toBe(false);
  });
});
