// Exact active-job cancellation and schedule ownership.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCronJobActive,
  getActiveCronJobCount,
  markCronJobActive,
  noteActiveCronJobRemoval,
  noteActiveCronJobScheduleMutation,
  noteActiveCronJobTriggerMutation,
  onCronJobInactive,
  resetCronActiveJobs,
} from "./active-jobs.js";

afterEach(() => {
  resetCronActiveJobs();
});

describe("active cron schedule ownership", () => {
  it("notifies only the removed marker when a same-id run replaces it", () => {
    const removedMarker = markCronJobActive("reused-job");
    const onRemovedInactive = vi.fn();
    onCronJobInactive(noteActiveCronJobRemoval("reused-job"), onRemovedInactive);
    const replacementMarker = markCronJobActive("reused-job");

    clearCronJobActive("reused-job", replacementMarker);
    expect(onRemovedInactive).not.toHaveBeenCalled();

    clearCronJobActive("reused-job", removedMarker);
    expect(onRemovedInactive).toHaveBeenCalledOnce();
  });

  it("records durable job removal without releasing the active run marker", () => {
    const marker = markCronJobActive("removed-job");

    noteActiveCronJobRemoval("removed-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBe(true);
    expect(marker?.cancellation).toEqual({
      kind: "requested",
      reason: "Cron job removed by operator.",
    });
    expect(getActiveCronJobCount()).toBe(1);
  });

  it("does not mistake an ordinary schedule edit for job removal", () => {
    const marker = markCronJobActive("updated-job");

    noteActiveCronJobScheduleMutation("updated-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBeUndefined();
  });

  it("does not create active markers when removing an idle job", () => {
    noteActiveCronJobRemoval("idle-removed-job");

    expect(getActiveCronJobCount()).toBe(0);
  });

  it("records durable schedule mutations on the admitted active run", () => {
    const marker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(marker?.scheduleMutated).toBe(true);
  });

  it("records trigger mutations without retiring schedule ownership", () => {
    const marker = markCronJobActive("trigger-edited-job");

    noteActiveCronJobTriggerMutation("trigger-edited-job");

    expect(marker?.triggerMutated).toBe(true);
    expect(marker?.scheduleMutated).toBeUndefined();
  });

  it("keeps trigger mutation ownership after the script is edited back", () => {
    const marker = markCronJobActive("trigger-restored-job");

    noteActiveCronJobTriggerMutation("trigger-restored-job");
    noteActiveCronJobTriggerMutation("trigger-restored-job");

    expect(marker?.triggerMutated).toBe(true);
  });

  it("does not create trigger markers for an idle job", () => {
    noteActiveCronJobTriggerMutation("idle-trigger-job");

    expect(getActiveCronJobCount()).toBe(0);
  });

  it("keeps a mutation after the schedule is edited back to its original value", () => {
    const marker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");
    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(marker?.scheduleMutated).toBe(true);
  });

  it("attributes later edits only to the replacement active run", () => {
    const retiredMarker = markCronJobActive("rescheduled-job");
    clearCronJobActive("rescheduled-job", retiredMarker);
    const replacementMarker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(retiredMarker?.scheduleMutated).toBeUndefined();
    expect(replacementMarker?.scheduleMutated).toBe(true);
  });

  it("does not create ownership markers for jobs without an active run", () => {
    noteActiveCronJobScheduleMutation("idle-job");

    expect(getActiveCronJobCount()).toBe(0);
  });

  it("keeps schedule ownership isolated across concurrent active jobs", () => {
    const markers = Array.from({ length: 64 }, (_, index) =>
      markCronJobActive(`rescheduled-job-${index}`),
    );

    for (let index = 0; index < markers.length; index += 2) {
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
    }

    for (const [index, marker] of markers.entries()) {
      expect(marker?.scheduleMutated).toBe(index % 2 === 0 ? true : undefined);
    }
  });
});
