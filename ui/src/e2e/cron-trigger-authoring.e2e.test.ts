// Real-Chromium coverage keeps automation condition authoring aligned with Gateway contracts.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation condition-trigger authoring",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const proofDirectoryParent = process.env.OPENCLAW_TRIGGER_UI_PROOF_DIR;
let proofDirectory: string | undefined;
beforeEach(() => {
  proofDirectory = proofDirectoryParent
    ? createControlUiE2eArtifactDir("cron-trigger-authoring", proofDirectoryParent)
    : undefined;
});
const proofStage = process.env.OPENCLAW_TRIGGER_UI_PROOF_STAGE ?? "after";
type CronTriggerTestApp = HTMLElement & { runtime?: { context: ApplicationContext } };

const scriptJob = {
  id: "existing-script-automation",
  configRevision: "existing-script-revision",
  name: "Script health check",
  enabled: true,
  createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "script", script: "return { ready: true };" },
  state: {},
};

function listResponse(jobs: unknown[]) {
  return {
    jobs,
    snapshotRevision: "trigger-authoring-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function cronMethodResponses(jobs: unknown[]) {
  return {
    "cron.add": { id: "new-automation" },
    "cron.list": {
      cases: [
        { match: { lastRunStatus: "error" }, response: listResponse([]) },
        { response: listResponse(jobs) },
      ],
    },
    "cron.runs": {
      entries: [],
      total: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
    "cron.status": { enabled: true, triggersEnabled: true, jobs: jobs.length, nextWakeAtMs: null },
  };
}

async function captureProof(page: Page, name: string) {
  if (!proofDirectory) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    path: path.join(proofDirectory, `${proofStage}-${name}.png`),
  });
}

async function captureTriggerCapabilityProof(page: Page, name: string) {
  await page
    .locator(".settings-row__title")
    .filter({ hasText: "Condition trigger" })
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureProof(page, name);
}

async function selectSeconds(page: Page) {
  const unit = page.locator("wa-select").filter({
    has: page.locator('[slot="label"]', { hasText: "Unit" }),
  });
  await unit.click();
  await page.getByRole("option", { name: "Seconds", exact: true }).click();
}

suite.define(() => {
  it("edits a converted monitor as an ordinary shared-session automation and saves scratch with CAS", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_050, width: 1_440 } },
      async ({ page }) => {
        const monitor = {
          ...scriptJob,
          id: "converted-monitor",
          name: "Proactive check",
          sessionTarget: "session:agent:main:main",
          wakeMode: "now",
          activeHours: { start: "22:00", end: "06:00", timezone: "Europe/Vienna" },
          idleOnly: true,
          payload: { kind: "agentTurn", message: "Check job scratch", skipIfScratchEmpty: true },
          delivery: { mode: "announce", target: "owner", directPolicy: "block" },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...cronMethodResponses([monitor]),
            "cron.update": {
              ...monitor,
              configRevision: "updated-monitor-revision",
              name: "Evening check",
            },
            "cron.scratch.get": {
              scratch: { content: "- Review synthetic alerts", revision: 4, updatedAtMs: 1 },
              currentRevision: 4,
              maxBytes: 262144,
            },
            "cron.scratch.set": { ok: false, reason: "revision-conflict", currentRevision: 5 },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-row-converted-monitor"]').click();
        await page.locator("#cron-name").fill("Evening check");
        await page.locator("details.cron-advanced > summary").click();
        expect(await page.locator("#cron-active-hours-start").inputValue()).toBe("22:00");
        await page.locator("#cron-active-hours-end").fill("07:00");
        await page
          .locator(".settings-row--toggle")
          .filter({ hasText: "Skip empty scratch" })
          .click();
        await page.locator('[data-test-id="cron-submit"]').click();
        const update = await gateway.waitForRequest("cron.update");
        expect(update.params).toMatchObject({
          id: monitor.id,
          expectedConfigRevision: monitor.configRevision,
          patch: {
            name: "Evening check",
            sessionTarget: monitor.sessionTarget,
            activeHours: { ...monitor.activeHours, end: "07:00" },
            idleOnly: true,
            payload: { ...monitor.payload, skipIfScratchEmpty: false },
            delivery: monitor.delivery,
          },
        });
        expect(JSON.stringify(update.params)).not.toContain('"channel":"last"');
        expect(await gateway.getRequests("cron.scratch.get")).toHaveLength(0);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        expect(await gateway.getRequests("set-heartbeats")).toHaveLength(0);

        const scratch = page.locator("openclaw-cron-scratch-editor");
        await scratch.locator("summary").click();
        await scratch.getByRole("button", { name: "Load scratch", exact: true }).click();
        const editor = scratch.getByRole("textbox", { name: "Scratch content" });
        await expect.poll(() => editor.inputValue()).toBe("- Review synthetic alerts");
        await editor.fill("- Updated operator checklist");
        await scratch.getByRole("button", { name: "Save scratch", exact: true }).click();
        const firstSave = await gateway.waitForRequest("cron.scratch.set");
        expect(firstSave.params).toEqual({
          id: monitor.id,
          content: "- Updated operator checklist",
          expectedRevision: 4,
        });
        await scratch
          .getByRole("status")
          .filter({ hasText: "Scratch changed during editing" })
          .waitFor();
        expect(await editor.inputValue()).toBe("- Updated operator checklist");
        expect(
          await scratch.getByRole("button", { name: "Save scratch", exact: true }).isDisabled(),
        ).toBe(true);

        expect(
          await scratch.getByRole("button", { name: "Remove scratch", exact: true }).isDisabled(),
        ).toBe(true);
        await gateway.setMethodResponse("cron.scratch.get", {
          scratch: { content: "- Another writer's checklist", revision: 5, updatedAtMs: 2 },
          currentRevision: 5,
          maxBytes: 262144,
        });
        await scratch.getByRole("button", { name: "Reload scratch", exact: true }).click();
        await expect.poll(() => editor.inputValue()).toBe("- Another writer's checklist");
        await gateway.setMethodResponse("cron.scratch.set", {
          ok: true,
          scratch: { content: "", revision: 6, updatedAtMs: 3 },
          currentRevision: 6,
          maxBytes: 262144,
        });
        await editor.fill("");
        await scratch.getByRole("button", { name: "Save scratch", exact: true }).click();
        const emptySave = await gateway.waitForRequest("cron.scratch.set", { after: 1 });
        expect(emptySave.params).toEqual({ id: monitor.id, content: "", expectedRevision: 5 });
        await scratch.getByRole("status").filter({ hasText: "Scratch saved." }).waitFor();
        await gateway.setMethodResponse("cron.scratch.set", {
          ok: true,
          scratch: null,
          currentRevision: 7,
          maxBytes: 262144,
        });
        await scratch.getByRole("button", { name: "Remove scratch", exact: true }).click();
        const removal = await gateway.waitForRequest("cron.scratch.set", { after: 2 });
        expect(removal.params).toEqual({ id: monitor.id, content: null, expectedRevision: 6 });
        await scratch.getByText("No scratch saved.", { exact: false }).waitFor();

        // A multi-byte draft can exceed the byte limit without exceeding textarea maxlength.
        await gateway.setMethodResponse("cron.scratch.get", {
          scratch: { content: "notes", revision: 8, updatedAtMs: 4 },
          currentRevision: 8,
          maxBytes: 8,
        });
        await scratch.getByRole("button", { name: "Reload scratch", exact: true }).click();
        await expect.poll(() => editor.inputValue()).toBe("notes");
        await editor.fill("é".repeat(8));
        expect(
          await scratch.getByRole("button", { name: "Save scratch", exact: true }).isDisabled(),
        ).toBe(true);
        expect(
          await scratch.getByRole("button", { name: "Remove scratch", exact: true }).isEnabled(),
        ).toBe(true);
        await gateway.setMethodResponse("cron.scratch.set", {
          ok: true,
          scratch: null,
          currentRevision: 9,
          maxBytes: 8,
        });
        await scratch.getByRole("button", { name: "Remove scratch", exact: true }).click();
        const oversizedRemoval = await gateway.waitForRequest("cron.scratch.set", { after: 3 });
        expect(oversizedRemoval.params).toEqual({
          id: monitor.id,
          content: null,
          expectedRevision: 8,
        });
        await scratch.getByText("No scratch saved.", { exact: false }).waitFor();
        await captureProof(page, "monitor-scratch-cas");
      },
    );
  });

  it("fences stale scratch reads and allows CAS deletion of redacted scratch without enabling overwrite", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const jobs = ["first", "second"].map((id) =>
        Object.assign({}, scriptJob, {
          id,
          name: id,
          payload: { kind: "agentTurn", message: "Check scratch" },
        }),
      );
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...cronMethodResponses(jobs),
          "cron.scratch.get": {
            scratch: { content: "token=synthetic-private-token", revision: 2, updatedAtMs: 2 },
            currentRevision: 2,
            maxBytes: 262144,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-row-first"]').click();
      let scratch = page.locator("openclaw-cron-scratch-editor");
      await scratch.locator("summary").click();
      await gateway.deferNext("cron.scratch.get");
      await scratch.getByRole("button", { name: "Load scratch", exact: true }).click();
      await gateway.waitForRequest("cron.scratch.get");
      await page.locator('[data-test-id="cron-back"]').click();
      await page.locator('[data-test-id="cron-row-second"]').click();
      scratch = page.locator("openclaw-cron-scratch-editor");
      await gateway.resolveDeferred("cron.scratch.get", {
        scratch: { content: "Private first job notes", revision: 1, updatedAtMs: 1 },
        currentRevision: 1,
        maxBytes: 262144,
      });
      await scratch.locator("summary").click();
      await scratch.getByRole("button", { name: "Load scratch", exact: true }).click();
      await scratch.getByText("Sensitive content was redacted.", { exact: false }).waitFor();
      const editor = scratch.getByRole("textbox", { name: "Scratch content" });
      expect(await editor.inputValue()).toContain("[redacted]");
      expect(await editor.inputValue()).not.toContain("synthetic-private-token");
      expect(await scratch.textContent()).not.toContain("Private first job notes");
      expect(
        await scratch.getByRole("button", { name: "Save scratch", exact: true }).isDisabled(),
      ).toBe(true);
      expect(await editor.getAttribute("readonly")).not.toBeNull();
      expect(await gateway.getRequests("cron.scratch.set")).toHaveLength(0);
      await gateway.setMethodResponse("cron.scratch.set", {
        ok: true,
        scratch: null,
        currentRevision: 3,
        maxBytes: 262144,
      });
      await scratch.getByRole("button", { name: "Remove scratch", exact: true }).click();
      const removal = await gateway.waitForRequest("cron.scratch.set");
      expect(removal.params).toEqual({ id: "second", content: null, expectedRevision: 2 });
      await scratch.getByText("No scratch saved.", { exact: false }).waitFor();
      expect(await editor.inputValue()).toBe("");
    });
  });

  it("prevents unsupported condition triggers while preserving valid interval submissions", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_050, width: 1_440 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: cronMethodResponses([scriptJob]),
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-row-existing-script-automation"]').click();
        await page.locator("details.cron-advanced > summary").click();

        const scriptTriggerControlCount = await page
          .locator("wa-switch.settings-toggle")
          .filter({ hasText: "Condition trigger" })
          .count();
        await page
          .getByText("Condition trigger", { exact: true })
          .evaluate((element) => element.scrollIntoView({ block: "center" }));
        await captureProof(page, "01-script-payload-condition-control");

        await page.locator('[data-test-id="cron-back"]').click();
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Conditional interval");
        await page.locator("#cron-payload-text").fill("Run when the condition matches");
        await selectSeconds(page);
        await page.locator("#cron-every-amount").fill("5");
        await page.locator("details.cron-advanced > summary").click();
        await page
          .locator(".settings-row--toggle")
          .filter({ hasText: "Condition trigger" })
          .click();
        await page.locator("#cron-trigger-script").fill("json({ fire: true })");
        await page
          .locator("#cron-every-amount")
          .evaluate((element) => element.scrollIntoView({ block: "center" }));
        await captureProof(page, "02-triggered-five-second-validation");

        expect(scriptTriggerControlCount).toBe(0);

        const intervalError = page.locator("#cron-error-everyAmount");
        await intervalError.waitFor({ state: "visible" });
        expect(await intervalError.textContent()).toMatch(/30/);
        expect(await page.locator("#cron-every-amount").getAttribute("aria-invalid")).toBe("true");
        expect(await page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(true);
        expect(await gateway.getRequests("cron.add")).toHaveLength(0);

        await page.locator("#cron-every-amount").fill("30");
        await expect.poll(async () => intervalError.count()).toBe(0);
        expect(await page.locator('[data-test-id="cron-submit"]').isEnabled()).toBe(true);
        await captureProof(page, "03-triggered-thirty-second-boundary");
        await page.locator('[data-test-id="cron-submit"]').click();

        const triggeredRequest = await gateway.waitForRequest("cron.add");
        expect(triggeredRequest.params).toMatchObject({
          name: "Conditional interval",
          schedule: { kind: "every", everyMs: 30_000 },
          trigger: { script: "json({ fire: true })", once: false },
        });
        await expect.poll(async () => page.locator('[data-test-id="cron-submit"]').count()).toBe(0);

        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Unconditional interval");
        await page.locator("#cron-payload-text").fill("Run every five seconds");
        await selectSeconds(page);
        await page.locator("#cron-every-amount").fill("5");

        expect(await page.locator("#cron-error-everyAmount").count()).toBe(0);
        expect(await page.locator('[data-test-id="cron-submit"]').isEnabled()).toBe(true);
        await captureProof(page, "04-untriggered-five-second-interval");

        const previousAdds = (await gateway.getRequests("cron.add")).length;
        await page.locator('[data-test-id="cron-submit"]').click();
        const untriggeredRequest = await gateway.waitForRequest("cron.add", {
          after: previousAdds,
        });
        expect(untriggeredRequest.params).toMatchObject({
          name: "Unconditional interval",
          schedule: { kind: "every", everyMs: 5_000 },
        });
        expect(untriggeredRequest.params).not.toHaveProperty("trigger");
      },
    );
  });

  it("keeps saved and unsaved trigger drafts separate from reconnect-refreshed scheduler capability", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_050, width: 1_440 } },
      async ({ page }) => {
        const initialConfig = { cron: { triggers: { enabled: true } } };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": {
              appliedConfigHash: "trigger-config-1",
              config: initialConfig,
              configRevisionHash: "trigger-config-1",
              hash: "trigger-config-1",
              issues: [],
              raw: JSON.stringify(initialConfig),
              valid: true,
            },
            "cron.list": listResponse([]),
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("details.cron-advanced > summary").click();
        const triggerToggle = page
          .locator(".settings-row--toggle")
          .filter({ hasText: "Condition trigger" });
        await expect.poll(() => triggerToggle.count()).toBe(1);

        const unsaved = await page.evaluate(async () => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          if (!config) {
            throw new Error("Runtime config capability is unavailable");
          }
          await config.ensureLoaded();
          config.setWritesSuspended(true);
          config.patchForm(["cron", "triggers", "enabled"], false);
          return { dirty: config.state.configFormDirty, needsApply: config.state.configNeedsApply };
        });
        expect(unsaved).toEqual({ dirty: true, needsApply: false });
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        await expect.poll(() => triggerToggle.count()).toBe(1);
        await captureTriggerCapabilityProof(page, "05-unsaved-disable-keeps-active-trigger");

        await page.evaluate(() => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          if (!config) {
            throw new Error("Runtime config capability is unavailable");
          }
          config.setWritesSuspended(false);
          // Observe this long-lived save through Gateway/state boundaries; returning its
          // promise through CDP lets Chromium collect it under full-shard memory pressure.
          void config.save();
        });
        const savedRequest = await gateway.waitForRequest("config.set");
        expect(JSON.parse(String((savedRequest.params as { raw?: string }).raw))).toEqual({
          cron: { triggers: { enabled: false } },
        });
        await expect
          .poll(() =>
            page.evaluate(() => {
              const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
                ?.context.runtimeConfig;
              return {
                dirty: config?.state.configFormDirty,
                needsApply: config?.state.configNeedsApply,
                saving: config?.state.configSaving,
              };
            }),
          )
          .toEqual({ dirty: false, needsApply: true, saving: false });
        expect(await gateway.getRequests("config.apply")).toHaveLength(0);
        await expect.poll(() => triggerToggle.count()).toBe(1);
        await captureTriggerCapabilityProof(page, "06-saved-unapplied-keeps-active-trigger");

        const previousStatuses = (await gateway.getRequests("cron.status")).length;
        await gateway.setMethodResponse("cron.status", {
          enabled: true,
          triggersEnabled: false,
          jobs: 0,
          nextWakeAtMs: null,
        });
        await gateway.closeLatest(1012, "refresh effective trigger capability");
        await expect
          .poll(async () => (await gateway.getRequests("cron.status")).length)
          .toBeGreaterThan(previousStatuses);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("details.cron-advanced > summary").click();
        await expect.poll(() => triggerToggle.count()).toBe(0);
        await page.getByText("Condition triggers are disabled by cron.triggers.enabled.").waitFor();
        await captureTriggerCapabilityProof(page, "07-reconnect-refreshes-disabled-trigger");

        const oppositeDraft = await page.evaluate(async () => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          if (!config) {
            throw new Error("Runtime config capability is unavailable");
          }
          await config.ensureLoaded();
          config.setWritesSuspended(true);
          config.patchForm(["cron", "triggers", "enabled"], true);
          return config.state.configFormDirty;
        });
        expect(oppositeDraft).toBe(true);
        await expect.poll(() => triggerToggle.count()).toBe(0);
        await captureTriggerCapabilityProof(
          page,
          "08-unsaved-enable-cannot-author-disabled-trigger",
        );
        await page.evaluate(async () => {
          const config = (document.querySelector("openclaw-app") as CronTriggerTestApp).runtime
            ?.context.runtimeConfig;
          await config?.discardDraft();
          config?.setWritesSuspended(false);
        });
      },
    );
  });

  it("keeps a rejected trigger draft visible without reloading inventory", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_050, width: 1_440 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: cronMethodResponses([scriptJob]),
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const existingRow = page.locator('[data-test-id="cron-row-existing-script-automation"]');
        await existingRow.waitFor();
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Malformed condition");
        await page.locator("#cron-payload-text").fill("Run when the condition matches");
        await page.locator("details.cron-advanced > summary").click();
        await page
          .locator(".settings-row--toggle")
          .filter({ hasText: "Condition trigger" })
          .click();
        const triggerScript = page.locator("#cron-trigger-script");
        await triggerScript.fill("const x = ;");
        const listsBeforeSave = (await gateway.getRequests("cron.list")).length;
        const submit = page.locator('[data-test-id="cron-submit"]');

        await gateway.deferNext("cron.add");
        await submit.click();
        const request = await gateway.waitForRequest("cron.add");
        expect(request.params).toMatchObject({
          name: "Malformed condition",
          trigger: { script: "const x = ;", once: false },
        });
        const message = "Condition script is invalid";
        await gateway.rejectDeferred("cron.add", { code: "INVALID_REQUEST", message });

        const errorBanner = page.locator(".cron-error-banner");
        await errorBanner.waitFor({ state: "visible" });
        expect(await errorBanner.textContent()).toContain(message);
        expect(await triggerScript.inputValue()).toBe("const x = ;");
        expect(await gateway.getRequests("cron.list")).toHaveLength(listsBeforeSave);
        await errorBanner.scrollIntoViewIfNeeded();
        await captureProof(page, "05-malformed-trigger-rejected");

        await page.locator('[data-test-id="cron-back"]').click();
        await existingRow.waitFor();
        expect(await gateway.getRequests("cron.list")).toHaveLength(listsBeforeSave);
      },
    );
  });
});
