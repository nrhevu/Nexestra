import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessEvent, RunSpec } from "@nexestra/core";
import { createTempGitRepo, type TempGitRepo } from "@nexestra/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapter, FAKE_HARNESS_VERSION } from "./adapter.js";
import type { FakeHarnessAdapter } from "./scripted.js";

let repo: TempGitRepo;

beforeEach(async () => {
  repo = await createTempGitRepo({ prefix: "nexestra-fake-" });
});

afterEach(async () => {
  await repo.cleanup();
});

function specFor(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    taskId: "task_a",
    kind: "execute",
    cwd: repo.repo,
    instructions: "Create `src/hello.ts`.",
    sandbox: "workspace-write",
    timeoutMs: 60_000,
    ...overrides,
  };
}

/** Prepare + drain one run. */
async function runOnce(
  adapter: FakeHarnessAdapter,
  spec: RunSpec = specFor(),
): Promise<HarnessEvent[]> {
  const prepared = await adapter.prepare(spec);
  const events: HarnessEvent[] = [];
  for await (const event of adapter.run(prepared, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

const types = (events: readonly HarnessEvent[]): string[] => events.map((event) => event.type);

describe("discover", () => {
  it("reports the fake version and healthy auth", async () => {
    const info = await createFakeAdapter().discover();
    expect(info.available).toBe(true);
    expect(info.version).toBe(FAKE_HARNESS_VERSION);
    expect(info.authOk).toBe(true);
    expect(info.models).toContain("fake-model");
    expect(info.sandboxModes).toContain("workspace-write");
    expect(info.warnings.join(" ")).toContain("fake harness");
  });

  it("impersonates whichever harness it was registered as", async () => {
    expect((await createFakeAdapter({ id: "opencode" }).discover()).id).toBe("opencode");
  });
});

describe("success", () => {
  it("really writes the files the instructions name", async () => {
    const adapter = createFakeAdapter({ delayMs: 0 });
    const events = await runOnce(adapter);

    const written = await readFile(path.join(repo.repo, "src/hello.ts"), "utf8");
    expect(written).toContain("task_a");
    expect(await repo.status()).toContain("src/hello.ts");

    expect(types(events)).toEqual([
      "started",
      "assistant_text",
      "tool_call",
      "tool_result",
      "file_changed",
      "command",
      "usage",
      "final",
      "ended",
    ]);
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });
  });

  it("reports usage with a cost", async () => {
    const events = await runOnce(createFakeAdapter({ delayMs: 0 }));
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type !== "usage") throw new Error("no usage event");
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.costUSD ?? 0).toBeGreaterThan(0);
  });

  it("uses deterministic ids", async () => {
    const first = await runOnce(createFakeAdapter({ delayMs: 0 }));
    const second = await runOnce(createFakeAdapter({ delayMs: 0 }));
    expect(first[0]).toEqual({ type: "started", sessionRef: "fake_task_a_execute_1" });
    expect(first[0]).toEqual(second[0]);
    expect(first.filter((e) => e.type === "tool_call")).toEqual(
      second.filter((e) => e.type === "tool_call"),
    );
  });

  it("writes a scratch file when the instructions name none", async () => {
    const adapter = createFakeAdapter({ delayMs: 0 });
    await runOnce(adapter, specFor({ instructions: "Make the tests pass." }));
    expect(await repo.status()).toContain("nexestra-fake/task_a.md");
  });

  it("takes an explicit file map", async () => {
    const adapter = createFakeAdapter({
      delayMs: 0,
      filesFor: () => ({ "docs/from-fake.md": "# hi\n" }),
    });
    await runOnce(adapter);
    expect(await readFile(path.join(repo.repo, "docs/from-fake.md"), "utf8")).toBe("# hi\n");
  });
});

describe("retryable_failure_then_success", () => {
  it("fails the first attempt and passes the second", async () => {
    const adapter = createFakeAdapter({
      delayMs: 0,
      scenario: "retryable_failure_then_success",
    });

    const first = await runOnce(adapter);
    const error = first.find((event) => event.type === "error");
    if (error?.type !== "error") throw new Error("no error event");
    expect(error.retryable).toBe(true);
    expect(first.at(-1)).toEqual({ type: "ended", exitCode: 1 });
    expect(await repo.status()).toBe("");

    const second = await runOnce(adapter);
    expect(second.at(-1)).toEqual({ type: "ended", exitCode: 0 });
    expect(await repo.status()).toContain("src/hello.ts");
  });
});

describe("fatal_failure", () => {
  it("fails in a way no retry fixes", async () => {
    const events = await runOnce(createFakeAdapter({ delayMs: 0, scenario: "fatal_failure" }));
    const error = events.find((event) => event.type === "error");
    if (error?.type !== "error") throw new Error("no error event");
    expect(error.retryable).toBe(false);
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
  });
});

describe("permission_request", () => {
  it("waits for an answer, then writes on approval", async () => {
    const adapter = createFakeAdapter({ delayMs: 0, scenario: "permission_request" });
    const prepared = await adapter.prepare(specFor());

    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(prepared, new AbortController().signal)) {
      events.push(event);
      if (event.type === "permission_request") {
        await adapter.control(prepared.runId, {
          action: "answer_permission",
          requestId: event.requestId,
          approved: true,
        });
      }
    }

    expect(types(events)).toContain("permission_request");
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });
    expect(await repo.status()).toContain("src/hello.ts");
  });

  it("ends without writing when the answer is no", async () => {
    const adapter = createFakeAdapter({ delayMs: 0, scenario: "permission_request" });
    const prepared = await adapter.prepare(specFor());

    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(prepared, new AbortController().signal)) {
      events.push(event);
      if (event.type === "permission_request") {
        await adapter.control(prepared.runId, {
          action: "answer_permission",
          requestId: event.requestId,
          approved: false,
        });
      }
    }

    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
    expect(await repo.status()).toBe("");
  });
});

describe("slow", () => {
  it("streams over time and stops when cancelled", async () => {
    const adapter = createFakeAdapter({ scenario: "slow", slowMs: 10_000 });
    const prepared = await adapter.prepare(specFor());

    const started = Date.now();
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(prepared, new AbortController().signal)) {
      events.push(event);
      if (event.type === "started") {
        await adapter.control(prepared.runId, { action: "cancel", reason: "user" });
      }
    }

    expect(Date.now() - started).toBeLessThan(5_000);
    // A cancelled run ends like `codex exec` does: an error, then `ended`, no `final`.
    expect(types(events)).toEqual(["started", "error", "ended"]);
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
  });

  it("honours the caller's AbortSignal too", async () => {
    const adapter = createFakeAdapter({ scenario: "slow", slowMs: 10_000 });
    const prepared = await adapter.prepare(specFor());
    const controller = new AbortController();

    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(prepared, controller.signal)) {
      events.push(event);
      if (event.type === "started") controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
  });

  it("finishes on its own when left alone", async () => {
    const events = await runOnce(createFakeAdapter({ scenario: "slow", slowMs: 25 }));
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });
    expect(await repo.status()).toContain("src/hello.ts");
  });
});

describe("review", () => {
  it("defaults a review run to a clean review", async () => {
    const events = await runOnce(
      createFakeAdapter({ delayMs: 0 }),
      specFor({ kind: "review", instructions: "Review the diff." }),
    );
    const final = events.find((event) => event.type === "final");
    if (final?.type !== "final") throw new Error("no final event");
    expect(final.structured).toMatchObject({ findings: [] });
  });

  it("returns blocking findings when asked", async () => {
    const events = await runOnce(
      createFakeAdapter({ delayMs: 0, scenario: "review_with_findings" }),
      specFor({ kind: "review", instructions: "Review the diff." }),
    );
    const final = events.find((event) => event.type === "final");
    if (final?.type !== "final") throw new Error("no final event");
    const structured = final.structured as { findings: { severity: string }[] };
    expect(structured.findings.length).toBeGreaterThan(0);
    expect(structured.findings.some((finding) => finding.severity === "high")).toBe(true);
    // The review answer is also parseable straight out of the final message.
    expect(JSON.parse(final.message)).toMatchObject({ findings: structured.findings });
  });
});

describe("scenario resolution", () => {
  it("takes the scenario from the instructions", async () => {
    const events = await runOnce(
      createFakeAdapter({ delayMs: 0 }),
      specFor({ instructions: "Create `src/hello.ts`.\n[scenario: fatal_failure]" }),
    );
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
  });

  it("lets scenarioFor override the instructions", async () => {
    const adapter = createFakeAdapter({
      delayMs: 0,
      scenarioFor: (spec) => (spec.kind === "verify" ? "fatal_failure" : undefined),
    });
    const verify = await runOnce(adapter, specFor({ kind: "verify" }));
    expect(verify.at(-1)).toEqual({ type: "ended", exitCode: 1 });

    const execute = await runOnce(adapter, specFor());
    expect(execute.at(-1)).toEqual({ type: "ended", exitCode: 0 });
  });

  it("records every call it prepared", async () => {
    const adapter = createFakeAdapter({ delayMs: 0 });
    await runOnce(adapter);
    await runOnce(adapter);
    expect(adapter.calls.map((call) => call.attempt)).toEqual([1, 2]);
    expect(adapter.calls[0]?.taskId).toBe("task_a");
  });
});

describe("control", () => {
  it("rejects actions it says it does not support", async () => {
    const adapter = createFakeAdapter({ supports: ["cancel"] });
    await expect(adapter.control("run_x", { action: "steer", message: "hi" })).rejects.toThrow(
      /does not support/,
    );
  });
});
