import { describe, expect, it } from "vitest";
import { validateChatAbortParams, validateSessionsSendParams } from "./index.js";
import { formatValidationErrors, mentionsUnexpectedProperty } from "./validation-errors.js";

describe("protocol validation error text", () => {
  it("quotes a rejected property without single quotes", () => {
    expect(validateChatAbortParams({ sessionKey: "agent:main:cli", bogusField: 1 })).toBe(false);

    const message = formatValidationErrors(validateChatAbortParams.errors);

    // Validation text reaches LLM tool callers as tool-result content. A single-quoted
    // name is not JSON string syntax and #81925 recorded a caller copying the
    // delimiter into the key it retried with.
    expect(message).toContain("unexpected property `bogusField`");
    expect(message).not.toContain("'bogusField'");
    expect(message).not.toContain("'");
  });

  it("quotes a missing required property the same way", () => {
    expect(validateSessionsSendParams({})).toBe(false);

    const message = formatValidationErrors(validateSessionsSendParams.errors);

    expect(message).toContain("must have required property `");
    expect(message).not.toContain("'");
  });

  it("recognizes a rejected property in current and legacy wording", () => {
    const current = "invalid cron.add params: at root: unexpected property `sessionTarget`";
    const legacy = "invalid cron.add params: at root: unexpected property 'sessionTarget'";

    // A peer's wording is decided by the peer's build, so both must match.
    expect(mentionsUnexpectedProperty(current, "sessionTarget")).toBe(true);
    expect(mentionsUnexpectedProperty(legacy, "sessionTarget")).toBe(true);
    expect(mentionsUnexpectedProperty(current, "session")).toBe(false);
    expect(mentionsUnexpectedProperty(legacy, "session")).toBe(false);
    expect(
      mentionsUnexpectedProperty("invalid cron.add params: must be object", "sessionTarget"),
    ).toBe(false);
  });
});
