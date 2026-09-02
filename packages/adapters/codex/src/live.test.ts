/**
 * Opt-in live smoke test.
 *
 * Runs the real `codex` binary against a throwaway git repo with the cheapest
 * prompt that still produces a file change. Skipped unless
 * `NEXESTRA_LIVE_CODEX=1`, because it costs tokens and needs a logged-in CLI.
 *
 *   NEXESTRA_LIVE_CODEX=1 pnpm --filter @nexestra/adapter-codex test
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HarnessEvent } from "@nexestra/core";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexAdapter } from "./adapter.js";

const LIVE = process.env.NEXESTRA_LIVE_CODEX === "1";
const MODEL = process.env.NEXESTRA_LIVE_CODEX_MODEL;

let root: string;
let repo: string;

describe.skipIf(!LIVE)("live codex smoke test", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nexestra-live-codex-"));
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

  it("discovers a usable, logged-in codex", async () => {
    const adapter = createCodexAdapter();
    const info = await adapter.discover();
    expect(info.available).toBe(true);
    expect(info.binaryPath).toBeTruthy();
    expect(info.authOk).toBe(true);
  });

  it("creates hello.txt and reports file_changed plus ended", async () => {
    const adapter = createCodexAdapter({
      ephemeral: true,
      ...(MODEL ? { defaultModel: MODEL } : {}),
    });
    const prepared = await adapter.prepare({
      taskId: "live_smoke",
      kind: "execute",
      cwd: repo,
      instructions:
        "Create a file named hello.txt in the working directory containing exactly the word hello. Do nothing else.",
      sandbox: "workspace-write",
      reasoning: "low",
      timeoutMs: 300_000,
    });

    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(prepared, new AbortController().signal)) {
      events.push(event);
    }

    const types = events.map((event) => event.type);
    expect(types).toContain("started");
    expect(types).toContain("ended");
    expect(events.at(-1)).toMatchObject({ type: "ended", exitCode: 0 });

    const final = events.find((event) => event.type === "final");
    expect(final).toBeDefined();

    // Codex reports `{path, kind}` only, so the file itself is the evidence.
    expect(await readFile(path.join(repo, "hello.txt"), "utf8")).toMatch(/hello/i);

    const changed = events.filter((event) => event.type === "file_changed");
    expect(changed.map((event) => event.path)).toContain("hello.txt");

    const structured = final?.structured as { diff?: { files: { path: string }[] } };
    expect(structured?.diff?.files.map((file) => file.path)).toContain("hello.txt");
  }, 600_000);
});
