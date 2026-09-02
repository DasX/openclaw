import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Debug diagnostics mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("control-ui-debug-diagnostics");
  }
});

suite.define(() => {
  it("renders canonical automation status and preserves raw protocol snapshots", async () => {
    if (captureUiProof) {
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 1000, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            status: {
              runtime: "diagnostics-e2e",
              heartbeat: {
                defaultAgentId: "main",
                agents: [{ enabled: false, every: "disabled" }],
              },
              securityAudit: { summary: { critical: 0, warn: 1, info: 2 } },
            },
            health: { ok: true, gateway: "healthy", heartbeatSeconds: 0 },
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 3, nextWakeAtMs: null },
            "models.list": {
              models: [
                {
                  available: true,
                  id: "gpt-5.6-luna",
                  name: "GPT-5.6 Luna",
                  provider: "openai",
                },
              ],
            },
            "diagnostics.lanes": {
              lanes: [
                {
                  lane: "main",
                  queuedCount: 0,
                  activeCount: 0,
                  maxConcurrent: 16,
                  draining: false,
                  generation: 1,
                },
              ],
              dynamic: null,
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}debug`);
        expect(response?.status()).toBe(200);
        await page.locator(".page-title", { hasText: "Debug" }).waitFor();
        const snapshots = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Snapshots" }),
        });
        await snapshots.waitFor();
        await expect.poll(() => snapshots.textContent()).toContain("1 warning");
        await expect
          .poll(() => snapshots.textContent())
          .toContain("Scheduler Enabled · 3 total jobs");
        await expect.poll(() => snapshots.textContent()).toContain("none scheduled");
        expect(await snapshots.textContent()).not.toContain("heartbeat");
        const raw = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Raw protocol / legacy inspection" }),
        });
        await expect.poll(() => raw.textContent()).toContain("diagnostics-e2e");
        await expect.poll(() => raw.textContent()).toContain("healthy");
        const payloads = await raw.locator("pre").allTextContents();
        expect(JSON.parse(payloads[0] ?? "null").heartbeat).toEqual({
          defaultAgentId: "main",
          agents: [{ enabled: false, every: "disabled" }],
        });
        expect(JSON.parse(payloads[1] ?? "null").heartbeatSeconds).toBe(0);
        const models = page.locator(".settings-section", {
          has: page.getByRole("heading", { name: "Models" }),
        });
        await expect.poll(() => models.textContent()).toContain("gpt-5.6-luna");

        for (const method of [
          "status",
          "health",
          "models.list",
          "diagnostics.lanes",
          "cron.status",
        ]) {
          const requests = await gateway.getRequests(method);
          expect(requests.length).toBeGreaterThanOrEqual(1);
          expect(requests[0]?.params).toEqual(
            method === "models.list" ? { agentId: "main", preparedOnly: true } : {},
          );
        }

        expect(await gateway.getRequests("last-heartbeat")).toHaveLength(0);

        const jobId = "7621d9a5-fb76-4598-b93f-93aa746d96b1";
        const runId = `manual:${jobId}:1788320410309:1`;
        await gateway.emitGatewayEvent("cron", {
          jobId,
          runId,
          action: "finished",
          status: "skipped",
        });
        await gateway.emitGatewayEvent("health", { ok: true });
        await page.getByRole("button", { name: /^Open overlay/ }).click();
        const overlay = page.getByRole("complementary", { name: "System busyness" });
        const events = overlay.locator(".debug-overlay__events");
        const eventTexts = [`cron · Job ${jobId} · Run ${runId} · skipped`, "health"];
        const layoutViolations = [];
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const text of eventTexts) {
            const row = events.locator("li", { has: page.getByText(text, { exact: true }) });
            await row.scrollIntoViewIfNeeded();
            await expect.poll(() => row.locator(".mono").textContent()).toBe(text);
            const layout = await row.evaluate((element) => {
              const span = element.querySelector(".mono")!;
              const timestamp = element.querySelector("time")!.getBoundingClientRect();
              const column = span.getBoundingClientRect();
              const rowBounds = element.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(span);
              const lines = Array.from(range.getClientRects());
              // Text content survives clipping: inspect every rendered line, including the outcome.
              const clippedLines = lines.filter(
                (line) =>
                  line.left < Math.max(column.left, rowBounds.left) - 1 ||
                  line.right > Math.min(column.right, rowBounds.right, timestamp.left) + 1 ||
                  line.top < rowBounds.top - 1 ||
                  line.bottom > rowBounds.bottom + 1,
              );
              return {
                lineCount: lines.length,
                clippedLines: clippedLines.map((line) => line.toJSON()),
                column: column.toJSON(),
                timestamp: timestamp.toJSON(),
              };
            });
            expect(layout.lineCount).toBeGreaterThan(0);
            if (layout.clippedLines.length > 0) {
              layoutViolations.push({ width, text, ...layout });
            }
          }
          if (captureUiProof) {
            await overlay.screenshot({ path: path.join(proofDir, `events-${width}.png`) });
          }
        }
        expect(layoutViolations).toEqual([]);
        await overlay.getByRole("button", { name: "Close", exact: true }).click();
        await page.setViewportSize({ height: 1000, width: 1280 });

        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "diagnostic-snapshots.png"),
          });
          await models.scrollIntoViewIfNeeded();
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "models-snapshot.png"),
          });
        }
      },
    );
  });
});
