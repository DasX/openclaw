import { describe, expect, it } from "vitest";
import { normalizeHeartbeatToolResponse } from "./heartbeat-tool-response.js";

describe("historical SDK heartbeat response parser", () => {
  it("preserves the shipped report shape without creating runtime outcomes", () => {
    expect(
      normalizeHeartbeatToolResponse({
        outcome: "progress",
        notify: false,
        summary: "checked",
        next_check: "15m",
      }),
    ).toEqual({ outcome: "progress", notify: false, summary: "checked", nextCheck: "15m" });
    expect(
      normalizeHeartbeatToolResponse({ outcome: "made-up", notify: true, summary: "bad" }),
    ).toBeUndefined();
  });
});
