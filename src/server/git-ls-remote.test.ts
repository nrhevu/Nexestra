import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseGitLsRemoteBranches } from "./git-ls-remote.js";

interface FixtureCase {
  name: string;
  raw: string;
  expected: {
    branches: Array<{ name: string; commit: string }>;
    truncated: boolean;
  };
}

describe("parseGitLsRemoteBranches", () => {
  it("matches the Git ls-remote parser fixture", async () => {
    const raw = await readFile(new URL("./fixtures/git-ls-remote.json", import.meta.url), "utf8");
    const cases = JSON.parse(raw) as FixtureCase[];
    for (const fixtureCase of cases) {
      expect(parseGitLsRemoteBranches(fixtureCase.raw), fixtureCase.name).toEqual(
        fixtureCase.expected,
      );
    }
  });

  it("skips branch names that expose stored credentials and reports truncation", () => {
    const commit = "a".repeat(40);
    const output = `${commit}\trefs/heads/visible\n${commit}\trefs/heads/feature-nexestra-fixture-secret\n`;
    const parsed = parseGitLsRemoteBranches(output, {
      redact: (value) => value.replaceAll("nexestra-fixture-secret", "[REDACTED]"),
    });
    expect(parsed).toEqual({
      branches: [{ name: "visible", commit }],
      truncated: true,
    });
  });

  it("omits branch names containing U+FFFD", () => {
    const commit = "a".repeat(40);
    const output = `${commit}\trefs/heads/visible\n${commit}\trefs/heads/br\uFFFDanch\n`;
    const parsed = parseGitLsRemoteBranches(output);
    expect(parsed).toEqual({
      branches: [{ name: "visible", commit }],
      truncated: true,
    });
  });

  it("caps the number of retained rows", () => {
    const commit = "a".repeat(40);
    const output = Array.from(
      { length: 6 },
      (_value, index) => `${commit}\trefs/heads/branch-${String(index)}\n`,
    ).join("");
    const parsed = parseGitLsRemoteBranches(output, { maxRows: 3 });
    expect(parsed.truncated).toBe(true);
    expect(parsed.branches.map((branch) => branch.name)).toEqual([
      "branch-0",
      "branch-1",
      "branch-2",
    ]);
  });
});
