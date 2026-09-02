import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HarnessEvent, HarnessEventSchema, type RunSpec } from "@nexestra/core";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodexAdapter } from "./adapter.js";
import { CodexUnsupportedControlError } from "./errors.js";
import type { CodexAdapterOptions } from "./options.js";
import { CODEX_REVIEW_FINDINGS_SCHEMA } from "./review.js";
import { FAKE_CODEX_SCRIPT, fixturesDir } from "./test-support.js";

let root: string;
let repo: string;
let binary: string;
let logFile: string;
let childPidFile: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execa("git", args, { cwd, stdin: "ignore" });
  return typeof result.stdout === "string" ? result.stdout : "";
}

function fixturePath(name: string): string {
  return path.join(fixturesDir(), `${name}.jsonl`);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nexestra-codex-"));
  repo = path.join(root, "repo");
  binary = path.join(root, "fake-codex");
  logFile = path.join(root, "fake.log");
  childPidFile = path.join(root, "child.pid");
  await writeFile(binary, FAKE_CODEX_SCRIPT, "utf8");
  await chmod(binary, 0o755);
  await execa("git", ["init", "-q", "-b", "main", repo], { stdin: "ignore" });
  await git(repo, "config", "user.email", "test@nexestra.local");
  await git(repo, "config", "user.name", "nexestra test");
  await writeFile(path.join(repo, "math.ts"), "export const mul = (a, b) => a * b;\n", "utf8");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "initial");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function adapterFor(env: Record<string, string>, overrides: CodexAdapterOptions = {}) {
  return createCodexAdapter({
    binaryPath: binary,
    env: { FAKE_LOG: logFile, FAKE_CHILD_PID_FILE: childPidFile, ...env },
    ...overrides,
  });
}

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    taskId: "task_1",
    kind: "execute",
    cwd: repo,
    instructions: "Add a function add(a, b).",
    sandbox: "workspace-write",
    timeoutMs: 60_000,
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

describe("prepare", () => {
  it("creates the run directory and writes the instructions", async () => {
    const adapter = adapterFor({});
    const prepared = await adapter.prepare(spec());
    expect(prepared.harness).toBe("codex");
    expect(prepared.cwd).toBe(repo);
    expect(prepared.worktreePath).toBe(repo);
    expect(prepared.instructionsPath).toContain(
      path.join(".nexestra", "runs", prepared.runId, "instructions.md"),
    );
    expect(await readFile(prepared.instructionsPath ?? "", "utf8")).toBe(
      "Add a function add(a, b).",
    );
    const manifest = JSON.parse(
      await readFile(path.join(repo, ".nexestra", "runs", prepared.runId, "run.json"), "utf8"),
    ) as { runId: string; hasOutputSchema: boolean };
    expect(manifest.runId).toBe(prepared.runId);
    expect(manifest.hasOutputSchema).toBe(false);
  });

  it("never copies process.env into the PreparedRun", async () => {
    const adapter = adapterFor({ FAKE_MODE: "success" });
    const prepared = await adapter.prepare(spec());
    expect(Object.keys(prepared.env).sort()).toEqual([
      "FAKE_CHILD_PID_FILE",
      "FAKE_LOG",
      "FAKE_MODE",
    ]);
    expect(prepared.env.PATH).toBeUndefined();
  });

  it("writes the output schema to disk and points --output-schema at it", async () => {
    const adapter = adapterFor({});
    const prepared = await adapter.prepare(
      spec({ outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } }),
    );
    const index = prepared.args.indexOf("--output-schema");
    expect(index).toBeGreaterThan(-1);
    const schemaPath = prepared.args[index + 1] ?? "";
    expect(JSON.parse(await readFile(schemaPath, "utf8"))).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });

  it("rejects a relative cwd", async () => {
    const adapter = adapterFor({});
    await expect(adapter.prepare(spec({ cwd: "relative/path" }))).rejects.toThrow(
      /must be absolute/,
    );
  });

  it("uses the injected run id factory", async () => {
    const adapter = adapterFor({}, { runIdFactory: () => "run_fixed" });
    const prepared = await adapter.prepare(spec());
    expect(prepared.runId).toBe("run_fixed");
  });
});

describe("run — successful stream", () => {
  it("replays a fixture into the normalised event sequence", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
      FAKE_LAST_MESSAGE: "All done: add(a, b) works.",
    });
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));

    for (const event of events) expect(() => HarnessEventSchema.parse(event)).not.toThrow();
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "assistant_text",
      "command",
      "command",
      "assistant_text",
      "command",
      "command",
      "assistant_text",
      "usage",
      "final",
      "ended",
    ]);
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });
  });

  it("prefers the -o file for the final message", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
      FAKE_LAST_MESSAGE: "the -o file wins",
    });
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    expect(final?.message).toBe("the -o file wins");
  });

  it("falls back to the last agent_message when -o was not written", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "no-last-message",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
    });
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    expect(final?.message).toContain("add(a, b)");
  });

  it("spawns with stdin closed and the prompt in argv", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
    });
    const prepared = await adapter.prepare(spec());
    await collect(adapter.run(prepared, new AbortController().signal));
    const log = await readFile(logFile, "utf8");
    expect(log).toContain("stdin:closed");
    expect(log).toContain("Add a function add(a, b).");
    expect(log).toContain("--json");
  });

  it("attaches the real git diff to final.structured", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
    });
    const prepared = await adapter.prepare(spec());
    await writeFile(path.join(repo, "hello.txt"), "hello\n", "utf8");
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    const structured = final?.structured as { diff?: { files: { path: string }[]; patch: string } };
    expect(structured.diff?.files.map((file) => file.path)).toEqual(["hello.txt"]);
    expect(structured.diff?.patch).toContain("+hello");
  });

  it("keeps the adapter's own run directory out of the diff", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
    });
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    const structured = final?.structured as { diff?: { files: { path: string }[] } };
    expect(structured.diff?.files).toEqual([]);
  });

  it("parses structured output when an output schema was given", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-output-schema"),
      FAKE_LAST_MESSAGE: '{"summary":"ok","status":"ok","filesChanged":["src/math.ts"]}',
    });
    const prepared = await adapter.prepare(
      spec({ outputSchema: { type: "object", additionalProperties: true } }),
    );
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    const structured = final?.structured as { output?: unknown; fileChanges?: unknown[] };
    expect(structured.output).toEqual({
      summary: "ok",
      status: "ok",
      filesChanged: ["src/math.ts"],
    });
    expect(structured.fileChanges).toHaveLength(2);
  });

  it("adds costUSD when a pricer is supplied", async () => {
    const adapter = adapterFor(
      { FAKE_MODE: "success", FAKE_STREAM_FILE: fixturePath("exec-edit-test") },
      { priceUsage: (_model, usage) => (usage.input_tokens ?? 0) * 0.000001 },
    );
    const prepared = await adapter.prepare(spec({ model: "gpt-5.1-codex" }));
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.costUSD).toBeCloseTo(0.056396, 9);
  });
});

describe("run — review mode", () => {
  it("maps a JSON findings answer into final.structured.findings", async () => {
    const findings = JSON.stringify({
      summary: "One issue found.",
      findings: [
        {
          title: "Missing null check",
          severity: "high",
          file: "math.ts",
          line: 3,
          body: "add() does not validate its inputs.",
        },
      ],
    });
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-review-uncommitted"),
      FAKE_LAST_MESSAGE: findings,
    });
    const prepared = await adapter.prepare(
      spec({ kind: "review", instructions: "", outputSchema: CODEX_REVIEW_FINDINGS_SCHEMA }),
    );
    expect(prepared.args).toContain("--uncommitted");
    expect(prepared.args).toContain("review");
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    const structured = final?.structured as {
      findings?: { title: string; severity: string }[];
      reviewSummary?: string;
    };
    expect(structured.findings).toEqual([
      {
        title: "Missing null check",
        severity: "high",
        file: "math.ts",
        line: 3,
        body: "add() does not validate its inputs.",
      },
    ]);
    expect(structured.reviewSummary).toBe("One issue found.");
  });

  it("degrades to an empty findings list when review answers in prose", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-review-uncommitted"),
      FAKE_LAST_MESSAGE: "The new add function is implemented correctly.",
    });
    const prepared = await adapter.prepare(spec({ kind: "review", instructions: "" }));
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    expect(final?.message).toContain("implemented correctly");
    const structured = final?.structured as { findings?: unknown[] } | undefined;
    expect(structured?.findings).toEqual([]);
  });
});

describe("run — failures", () => {
  it("turns a CLI argument error into a non-retryable error plus ended", async () => {
    const adapter = adapterFor({ FAKE_MODE: "argerror" });
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["error", "ended"]);
    const error = events[0];
    expect(error).toMatchObject({ type: "error", retryable: false });
    expect(error?.type === "error" && error.message).toContain("exit 2");
    expect(events[1]).toEqual({ type: "ended", exitCode: 2 });
  });

  it("emits error + ended when the stream stops without turn.completed", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "failure",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
    });
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["started", "error", "ended"]);
    const error = events[1];
    expect(error?.type === "error" && error.message).toContain("without a turn.completed event");
    // "connection reset" is transient, so a Nexestra-level retry is worth it.
    expect(error).toMatchObject({ retryable: true });
    // The benign `Reading additional input from stdin...` line is filtered out.
    expect(error?.type === "error" && error.message).not.toContain("additional input");
    expect(events.some((event) => event.type === "final")).toBe(false);
  });

  it("rejects a PreparedRun from another harness", async () => {
    const adapter = adapterFor({});
    const prepared = await adapter.prepare(spec());
    const iterable = adapter.run(
      { ...prepared, harness: "opencode" },
      new AbortController().signal,
    );
    await expect(collect(iterable)).rejects.toThrow(/expected "codex"/);
  });

  it("rejects a run id it never prepared", async () => {
    const adapter = adapterFor({});
    const prepared = await adapter.prepare(spec());
    const iterable = adapter.run(
      { ...prepared, runId: "run_unknown" },
      new AbortController().signal,
    );
    await expect(collect(iterable)).rejects.toThrow(/no run manifest/);
  });

  it("recovers the manifest from disk when prepare() ran in another process", async () => {
    const first = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
    });
    const prepared = await first.prepare(spec());
    const second = adapterFor({
      FAKE_MODE: "success",
      FAKE_STREAM_FILE: fixturePath("exec-edit-test"),
    });
    const events = await collect(second.run(prepared, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });
  });
});

describe("run — cancellation", () => {
  it("synthesises error + ended and no final on abort", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "hang",
      FAKE_STREAM_FILE: fixturePath("exec-cancelled-sigint"),
    });
    const prepared = await adapter.prepare(spec());
    const controller = new AbortController();
    const iterator = adapter.run(prepared, controller.signal)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "started" });

    controller.abort();
    const rest: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest.map((event) => event.type)).toEqual(["error", "ended"]);
    expect(rest[0]).toEqual({ type: "error", message: "cancelled", retryable: false });
    expect(rest.some((event) => event.type === "final")).toBe(false);
  }, 20_000);

  it("kills the whole process group, not just the leader", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "hang",
      FAKE_STREAM_FILE: fixturePath("exec-cancelled-sigint"),
    });
    const prepared = await adapter.prepare(spec());
    const controller = new AbortController();
    const iterator = adapter.run(prepared, controller.signal)[Symbol.asyncIterator]();
    await iterator.next();

    const grandchild = Number((await readFile(childPidFile, "utf8")).trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(alive(grandchild)).toBe(true);

    controller.abort();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
    }
    // The `sleep 120` the fake binary started must die with the group.
    expect(await waitForDeath(grandchild)).toBe(true);
  }, 20_000);

  it("cancels through control(runId, {action:'cancel'})", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "hang",
      FAKE_STREAM_FILE: fixturePath("exec-cancelled-sigint"),
    });
    const prepared = await adapter.prepare(spec());
    const iterator = adapter.run(prepared, new AbortController().signal)[Symbol.asyncIterator]();
    await iterator.next();
    await adapter.control(prepared.runId, { action: "cancel", reason: "user pressed stop" });

    const rest: HarnessEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(rest[0]).toEqual({
      type: "error",
      message: "user pressed stop",
      retryable: false,
    });
  }, 20_000);

  it("stops the process when the consumer abandons the iterator", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "hang",
      FAKE_STREAM_FILE: fixturePath("exec-cancelled-sigint"),
    });
    const prepared = await adapter.prepare(spec());
    for await (const event of adapter.run(prepared, new AbortController().signal)) {
      expect(event.type).toBe("started");
      break;
    }
    const grandchild = Number((await readFile(childPidFile, "utf8")).trim());
    expect(await waitForDeath(grandchild)).toBe(true);
  }, 20_000);

  it("times out a run that never finishes", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "hang",
      FAKE_STREAM_FILE: fixturePath("exec-cancelled-sigint"),
    });
    const prepared = await adapter.prepare(spec({ timeoutMs: 300 }));
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["started", "error", "ended"]);
    const error = events[1];
    expect(error?.type === "error" && error.message).toContain("timeout after 300ms");
    // A timeout is worth retrying; an explicit cancel is not.
    expect(error).toMatchObject({ retryable: true });
  }, 20_000);

  it("aborts immediately when the signal is already aborted", async () => {
    const adapter = adapterFor({
      FAKE_MODE: "hang",
      FAKE_STREAM_FILE: fixturePath("exec-cancelled-sigint"),
    });
    const prepared = await adapter.prepare(spec());
    const controller = new AbortController();
    controller.abort();
    const events = await collect(adapter.run(prepared, controller.signal));
    expect(events.at(-2)).toMatchObject({ type: "error", message: "cancelled" });
    expect(events.at(-1)?.type).toBe("ended");
  }, 20_000);
});

describe("control", () => {
  it("reports pause, resume, steer and answer_permission as unsupported", async () => {
    const adapter = adapterFor({});
    for (const action of [
      { action: "pause" },
      { action: "resume" },
      { action: "steer", message: "focus on tests" },
      { action: "answer_permission", requestId: "req_1", approved: true },
    ] as const) {
      const result = await adapter.controlDetailed("run_1", action);
      expect(result).toMatchObject({
        action: action.action,
        supported: false,
        requires: "app-server",
      });
      await expect(adapter.control("run_1", action)).rejects.toBeInstanceOf(
        CodexUnsupportedControlError,
      );
    }
  });

  it("mentions codex app-server in the reason", async () => {
    const adapter = adapterFor({});
    const result = await adapter.controlDetailed("run_1", { action: "steer", message: "x" });
    expect(result.supported === false && result.reason).toContain("codex app-server");
  });

  it("accepts cancel for a known but idle run", async () => {
    const adapter = adapterFor({});
    const prepared = await adapter.prepare(spec());
    const result = await adapter.controlDetailed(prepared.runId, { action: "cancel" });
    expect(result).toMatchObject({ action: "cancel", supported: true, applied: false });
  });

  it("reports an unknown run id without throwing", async () => {
    const adapter = adapterFor({});
    const result = await adapter.controlDetailed("run_nope", { action: "cancel" });
    expect(result).toMatchObject({ supported: true, applied: false });
    await expect(adapter.control("run_nope", { action: "cancel" })).resolves.toBeUndefined();
  });
});

describe("discover", () => {
  it("goes through the same code path as discoverCodex", async () => {
    const adapter = adapterFor({});
    const info = await adapter.discover();
    expect(info).toMatchObject({ id: "codex", available: true, authOk: true });
  });
});
