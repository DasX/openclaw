import { describe, expect, it } from "vitest";
import {
  compareOpenClawVersions,
  parseArgs,
  resolveDefaultReleaseUpgradeBaseline,
} from "../../scripts/lib/release-upgrade-baseline.mjs";

describe("release upgrade baseline resolver", () => {
  it("rejects short flag values before resolving baselines", () => {
    expect(() => parseArgs(["--candidate-version", "-h"])).toThrow(
      "missing value for --candidate-version",
    );
    expect(() => parseArgs(["--versions-json", "-h"])).toThrow("missing value for --versions-json");
  });

  it.each([
    { candidate: "2026.8.1", expected: "2026.7.1-2" },
    { candidate: "2026.8.1-beta.2", expected: "2026.7.1-2" },
    { candidate: "2026.8.1-alpha.2", expected: "2026.7.1-2" },
    { candidate: "2026.7.33", expected: "2026.7.1-2" },
    { candidate: "2026.7.1-2", expected: "2026.7.1-1" },
    { candidate: "2026.7.1-1", expected: "2026.7.1" },
    { candidate: "2026.7.1", expected: "2026.6.34" },
  ])("selects the stable predecessor of $candidate", ({ candidate, expected }) => {
    expect(
      resolveDefaultReleaseUpgradeBaseline(candidate, [
        "2026.8.1-beta.1",
        "2026.7.2-beta.7",
        "2026.7.1-1",
        "2026.9.1",
        "2026.8.1-alpha.1",
        "2026.7.1-2",
        "2026.6.34",
        "2026.7.1",
        "2026.8.1",
      ]),
    ).toBe(`openclaw@${expected}`);
  });

  it("uses the same stable version only when no older stable exists", () => {
    expect(resolveDefaultReleaseUpgradeBaseline("2026.6.2", ["2026.6.2", "2026.6.6"])).toBe(
      "openclaw@2026.6.2",
    );
  });

  it("rejects candidates with no stable baseline at or below them", () => {
    expect(() =>
      resolveDefaultReleaseUpgradeBaseline("2026.6.2-beta.2", ["2026.6.2-beta.1", "2026.6.2"]),
    ).toThrow("no published stable OpenClaw baseline");
  });

  it("does not pick a newer stable release for a prerelease candidate", () => {
    expect(
      resolveDefaultReleaseUpgradeBaseline("2026.6.7-beta.1", [
        "2026.6.6",
        "2026.6.7",
        "2026.6.7-beta.2",
      ]),
    ).toBe("openclaw@2026.6.6");
  });

  it("compares prerelease versions with semver ordering", () => {
    expect(compareOpenClawVersions("2026.6.7-beta.2", "2026.6.7-beta.10")).toBeLessThan(0);
    expect(compareOpenClawVersions("2026.6.7", "2026.6.7-beta.10")).toBeGreaterThan(0);
  });
});
