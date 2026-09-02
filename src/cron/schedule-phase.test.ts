// Covers deterministic phase anchors for cron-owned ordinary scheduler jobs.
import { describe, expect, it } from "vitest";
import { resolveSchedulePhaseMs } from "./schedule-phase.js";

describe("ordinary scheduler phase anchors", () => {
  it("derives a stable per-agent phase inside the interval", () => {
    const params = {
      schedulerSeed: "device-a",
      agentId: "main",
      intervalMs: 60 * 60_000,
    };
    const first = resolveSchedulePhaseMs(params);

    expect(resolveSchedulePhaseMs(params)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(params.intervalMs);
  });

  it("normalizes an invalid interval to a finite phase", () => {
    expect(
      resolveSchedulePhaseMs({
        schedulerSeed: "device-a",
        agentId: "main",
        intervalMs: Number.NaN,
      }),
    ).toBe(0);
  });
});
