/**
 * Opt-in live test: one real Codex run through the whole loop.
 *
 * Skipped unless `NEXESTRA_LIVE_CODEX=1`, because it costs tokens and needs a
 * logged-in Codex CLI.
 *
 *   NEXESTRA_LIVE_CODEX=1 pnpm --filter @nexestra/orchestrator test
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCodexAdapter } from "@nexestra/adapter-codex";
import { afterAll, describe, expect, it } from "vitest";
import { createOrchestrator } from "./orchestrator.js";
import { commandCriterion, createTestBed, type TestBed } from "./test-support.js";
import type { OrchestratorEvent } from "./types.js";

const LIVE = process.env.NEXESTRA_LIVE_CODEX === "1";
const MODEL = process.env.NEXESTRA_LIVE_CODEX_MODEL;

let bed: TestBed | undefined;

afterAll(async () => {
  await bed?.cleanup();
});

describe.skipIf(!LIVE)("live: a one-task plan through the real Codex adapter", () => {
  it("executes, verifies against a real command and merges", async () => {
    bed = await createTestBed({
      criteria: [commandCriterion("ac_1", "test -f hello.txt", "hello.txt exists")],
    });
    bed.addTask({
      id: "task_live",
      title: "Create hello.txt",
      description:
        "Create a file named hello.txt in the working directory containing exactly the word " +
        "hello. Do nothing else.",
      criteria: ["ac_1"],
    });

    const events: OrchestratorEvent[] = [];
    const orchestrator = createOrchestrator({
      store: bed.store,
      adapters: {
        codex: createCodexAdapter({
          ephemeral: true,
          ...(MODEL ? { defaultModel: MODEL } : {}),
        }),
      },
      master: {
        notify(event) {
          events.push(event);
        },
        requestReplan() {},
      },
      config: {
        worktreeRoot: bed.worktreeRoot,
        // One harness is registered, so there is nothing to cross-review with.
        reviewEnabled: false,
        verifyEnabled: true,
        autoMerge: true,
        runTimeoutMs: 300_000,
      },
    });

    await orchestrator.start(bed.thread.id);
    await orchestrator.drain(bed.thread.id);

    const task = bed.store.getTask("task_live");
    expect(task?.status).toBe("done");
    expect(task?.mergeState).toBe("merged");

    const run = bed.store.listRuns(bed.thread.id)[0];
    expect(run?.status).toBe("succeeded");
    expect(run?.harness).toBe("codex");
    expect(run?.sessionRef).toBeTruthy();

    const runEvents = bed.store.listRunEvents(run?.id ?? "");
    expect(runEvents.map((event) => event.type)).toContain("final");
    expect(runEvents.map((event) => event.type)).toContain("ended");

    const artifacts = bed.store.listArtifacts(bed.thread.id);
    const diff = artifacts.find((artifact) => artifact.kind === "diff");
    expect(diff?.preview).toContain("hello.txt");

    const evidence = artifacts.find((artifact) => artifact.title.startsWith("Verification"));
    expect(evidence?.title).toContain("pass");
    const bytes = await readFile(path.join(bed.store.dataDir, evidence?.path ?? ""), "utf8");
    expect(bytes).toContain("result: PASS");

    const spec = bed.store.getSpec(bed.thread.id);
    expect(spec?.acceptanceCriteria[0]?.satisfied).toBe(true);
    expect(spec?.acceptanceCriteria[0]?.evidenceArtifactId).toBe(evidence?.id);

    // The branch really landed on main.
    expect(existsSync(path.join(bed.repo, "hello.txt"))).toBe(true);
    expect(events.some((event) => event.type === "thread_idle")).toBe(true);

    await orchestrator.close();
  }, 900_000);
});
