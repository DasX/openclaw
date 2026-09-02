// Tests queue policy parsing and admission decisions.
import { describe, expect, it } from "vitest";
import { resolveActiveRunQueueAction } from "./queue-policy.js";

describe("resolveActiveRunQueueAction", () => {
  it("runs immediately when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("run-now");
  });

  it("queues followup work while another run is active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("enqueue-followup");
  });

  it("enqueues followups in collect mode", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("enqueue-followup");
  });

  it("runs reset-triggered turns immediately while another run is active", () => {
    for (const queueMode of ["collect", "followup"] as const) {
      expect(
        resolveActiveRunQueueAction({
          isActive: true,
          shouldFollowup: true,
          queueMode,
          resetTriggered: true,
        }),
      ).toBe("run-now");
    }
  });

  it("lets lifecycle reset admission supersede queued followups", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        shouldFollowup: true,
        queueMode: "followup",
        resetTriggered: true,
      }),
    ).toBe("run-now");
  });

  it("ignores reset-triggered policy when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        shouldFollowup: true,
        queueMode: "collect",
        resetTriggered: true,
      }),
    ).toBe("run-now");
  });
});
