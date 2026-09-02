/**
 * Opt-in live smoke test.
 *
 * Starts the real `opencode serve`, creates a session in a throwaway git repo
 * and runs the cheapest prompt that still produces a file change. Skipped
 * unless `NEXESTRA_LIVE_OPENCODE=1`, because it costs tokens and needs a
 * connected provider.
 *
 *   NEXESTRA_LIVE_OPENCODE=1 pnpm --filter @nexestra/adapter-opencode test
 *
 * `NEXESTRA_LIVE_OPENCODE_MODEL` overrides the model. The default below is the
 * one the protocol recordings used; the machine's own default (`9router/…`)
 * points at a local proxy that was not running (`docs/harness-protocols.md` §4.5).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@nexestra/core";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenCodeAdapter } from "./adapter.js";

const LIVE = process.env.NEXESTRA_LIVE_OPENCODE === "1";
const MODEL = process.env.NEXESTRA_LIVE_OPENCODE_MODEL ?? "openai/gpt-5.4-mini";

let root: string;
let repo: string;

describe.skipIf(!LIVE)("live opencode smoke test", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nexestra-live-opencode-"));
    repo = path.join(root, "repo");
    await execa("git", ["init", "-q", "-b", "main", repo], { stdin: "ignore" });
    await execa("git", ["config", "user.email", "live@nexestra.local"], { cwd: repo });
    await execa("git", ["config", "user.name", "nexestra live"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "# scratch\n", "utf8");
    await execa("git", ["add", "-A"], { cwd: repo });
    await execa("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("discovers a usable opencode with a connected provider", async () => {
    const adapter = createOpenCodeAdapter({ defaultModel: MODEL });
    try {
      const info = await adapter.discover();
      expect(info.available).toBe(true);
      expect(info.binaryPath).toBeTruthy();
      expect(info.version).toBeTruthy();
      expect(info.authOk).toBe(true);
      expect(info.models.length).toBeGreaterThan(0);
    } finally {
      await adapter.dispose();
    }
  }, 120_000);

  it("creates hello.txt and reports file_changed, final and ended", async () => {
    const adapter = createOpenCodeAdapter({ defaultModel: MODEL });
    try {
      const prepared = await adapter.prepare({
        taskId: "live_smoke",
        kind: "execute",
        cwd: repo,
        instructions:
          "Create a file named hello.txt in the working directory containing exactly the word hello. Do nothing else.",
        sandbox: "workspace-write",
        timeoutMs: 300_000,
      });

      const events: HarnessEvent[] = [];
      for await (const event of adapter.run(prepared, new AbortController().signal)) {
        events.push(event);
      }

      const types = events.map((event) => event.type);
      expect(types[0]).toBe("started");
      expect(events.at(-1)).toMatchObject({ type: "ended", exitCode: 0 });
      expect(types).toContain("final");

      // The file itself is the evidence; the harness' word for it is not.
      expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toMatch(/hello/i);

      const final = events.find((event) => event.type === "final");
      const structured = final?.structured as {
        diff?: { files: { path: string }[] };
        usage?: { steps: number };
      };
      expect(structured?.diff?.files.map((file) => file.path)).toContain("hello.txt");
      expect(structured?.usage?.steps ?? 0).toBeGreaterThan(0);
      expect(types).toContain("usage");

      // Printed so a live run leaves a record of what the harness actually did.
      console.log("live opencode summary", {
        model: MODEL,
        events: types.length,
        types: [...new Set(types)],
        usage: structured?.usage,
      });
    } finally {
      await adapter.dispose();
    }
  }, 600_000);
});
