import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFsWorkspaceReader } from "./workspace.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nexestra-master-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# demo\n\nA sample workspace.\n");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"demo"}');
  await fs.writeFile(
    path.join(root, "src", "index.ts"),
    "export const NEEDLE = 1;\nconst other = 2;\n",
  );
  await fs.writeFile(path.join(root, "src", "util.ts"), "// NEEDLE lives here too\n");
  await fs.writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "// NEEDLE\n");
  await fs.writeFile(path.join(root, ".git", "config"), "NEEDLE");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_workspace", () => {
  it("walks the tree, applies ignore rules and returns the manifests", async () => {
    const reader = createFsWorkspaceReader({ root });
    const result = await reader.readWorkspace({ includeManifests: true });
    const paths = result.entries.map((entry) => entry.path);

    expect(paths).toContain("README.md");
    expect(paths).toContain("src");
    expect(paths).toContain("src/index.ts");
    expect(paths.some((entry) => entry.startsWith("node_modules"))).toBe(false);
    expect(paths.some((entry) => entry.startsWith(".git"))).toBe(false);

    const manifestPaths = result.manifests.map((manifest) => manifest.path).sort();
    expect(manifestPaths).toEqual(["README.md", "package.json"]);
    const readme = result.manifests.find((manifest) => manifest.path === "README.md");
    expect(readme?.content).toContain("# demo");
  });

  it("can skip the manifests", async () => {
    const reader = createFsWorkspaceReader({ root });
    const result = await reader.readWorkspace({ includeManifests: false });
    expect(result.manifests).toHaveLength(0);
  });

  it("refuses to leave the workspace root", async () => {
    const reader = createFsWorkspaceReader({ root });
    await expect(reader.readWorkspace({ path: "../.." })).rejects.toThrow(/escapes the workspace/);
  });
});

describe("search_code", () => {
  for (const disableRipgrep of [false, true]) {
    const label = disableRipgrep ? "JS walk" : "ripgrep (when available)";

    it(`finds matches with line numbers — ${label}`, async () => {
      const reader = createFsWorkspaceReader({ root, disableRipgrep });
      const result = await reader.searchCode({ query: "NEEDLE" });
      const paths = result.matches.map((match) => match.path).sort();

      expect(paths).toEqual(["src/index.ts", "src/util.ts"]);
      expect(result.matches.every((match) => match.line > 0)).toBe(true);
      if (disableRipgrep) expect(result.engine).toBe("walk");
    });

    it(`honours maxResults — ${label}`, async () => {
      const reader = createFsWorkspaceReader({ root, disableRipgrep });
      const result = await reader.searchCode({ query: "NEEDLE", maxResults: 1 });
      expect(result.matches).toHaveLength(1);
      expect(result.truncated).toBe(true);
    });

    it(`supports regular expressions — ${label}`, async () => {
      const reader = createFsWorkspaceReader({ root, disableRipgrep });
      const result = await reader.searchCode({ query: "NEE[DE]LE", regex: true });
      expect(result.matches.length).toBeGreaterThan(0);
    });
  }

  it("filters by file pattern in the JS fallback", async () => {
    const reader = createFsWorkspaceReader({ root, disableRipgrep: true });
    const result = await reader.searchCode({ query: "NEEDLE", filePattern: "util.ts" });
    expect(result.matches.map((match) => match.path)).toEqual(["src/util.ts"]);
  });
});
