// Tests typing indicator policy across internal, quiet, and visible channels.
import { describe, expect, it } from "vitest";
import { resolveRunTypingPolicy } from "./typing-policy.js";

describe("resolveRunTypingPolicy", () => {
  it("keeps internal events silent without a channel route", () => {
    const resolved = resolveRunTypingPolicy({
      requestedPolicy: "user_message",
      systemEvent: true,
    });
    expect(resolved).toEqual({
      typingPolicy: "system_event",
      suppressTyping: true,
    });
  });

  it("forces internal webchat policy", () => {
    const resolved = resolveRunTypingPolicy({
      requestedPolicy: "user_message",
      originatingChannel: "webchat",
    });
    expect(resolved).toEqual({
      typingPolicy: "internal_webchat",
      suppressTyping: true,
    });
  });

  it("forces system event policy for routed turns", () => {
    const resolved = resolveRunTypingPolicy({
      requestedPolicy: "user_message",
      systemEvent: true,
      originatingChannel: "quietchat",
    });
    expect(resolved).toEqual({
      typingPolicy: "system_event",
      suppressTyping: true,
    });
  });

  it("preserves requested policy for regular user turns", () => {
    const resolved = resolveRunTypingPolicy({
      requestedPolicy: "user_message",
      originatingChannel: "quietchat",
    });
    expect(resolved).toEqual({
      typingPolicy: "user_message",
      suppressTyping: false,
    });
  });

  it("respects explicit suppressTyping", () => {
    const resolved = resolveRunTypingPolicy({
      requestedPolicy: "auto",
      originatingChannel: "quietchat",
      suppressTyping: true,
    });
    expect(resolved).toEqual({
      typingPolicy: "auto",
      suppressTyping: true,
    });
  });
});
