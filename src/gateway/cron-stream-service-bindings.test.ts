import { describe, expect, it, vi } from "vitest";
import { createCronStreamServiceBindings } from "./cron-stream-service-bindings.js";

function createService() {
  return {
    updateExternalState: vi.fn(async () => true),
    retireExternalStreamSource: vi.fn(async () => "source:retired"),
    updateExternalCounters: vi.fn(async () => {}),
    recordExternalFailure: vi.fn(async () => {}),
  };
}

describe("cron stream service bindings", () => {
  it.each([undefined, { settlement: true }])(
    "forwards owner writes to the cron service with options %o",
    async (options) => {
      const service = createService();
      const bindings = createCronStreamServiceBindings(service);

      await expect(
        bindings.updateState("job", { streamStatus: "stopped" }, "key", "identity", options),
      ).resolves.toBe(true);
      await expect(bindings.retireSource("job", "key", "identity", options)).resolves.toBe(
        "source:retired",
      );
      await bindings.recordFailure(
        "job",
        "boom",
        { streamStatus: "error" },
        "key",
        "identity",
        options,
      );
      await bindings.updateCounters?.("job", {
        streamDroppedBatches: 1,
        streamCoalescedBatches: 2,
      });

      expect(service.updateExternalState).toHaveBeenCalledExactlyOnceWith(
        "job",
        "key",
        "identity",
        { streamStatus: "stopped" },
        options,
      );
      expect(service.retireExternalStreamSource).toHaveBeenCalledExactlyOnceWith(
        "job",
        "key",
        "identity",
        options,
      );
      expect(service.recordExternalFailure).toHaveBeenCalledExactlyOnceWith(
        "job",
        "boom",
        { streamStatus: "error" },
        { scheduleKey: "key", identity: "identity" },
        options,
      );
      expect(service.updateExternalCounters).toHaveBeenCalledExactlyOnceWith("job", {
        streamDroppedBatches: 1,
        streamCoalescedBatches: 2,
      });
    },
  );
});
