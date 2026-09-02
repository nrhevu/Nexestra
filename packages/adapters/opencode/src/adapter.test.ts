import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HarnessEvent, HarnessEventSchema, type RunSpec } from "@nexestra/core";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenCodeAdapter, type OpenCodeAdapter, splitModelRef } from "./adapter.js";
import { OpenCodeUnsupportedControlError } from "./errors.js";
import type { OpenCodeAdapterOptions } from "./options.js";
import {
  API_ERROR_SESSION_ID,
  eventsForSession,
  FakeOpenCodeServer,
  loadSseEvents,
  OPENCODE_SSE_FIXTURES,
  type OpenCodeSseFixtureName,
  readJsonFixture,
} from "./test-support.js";
import type { OpenCodeEvent, OpenCodePermissionRuleset } from "./types.js";

const MESSAGES = readJsonFixture<unknown>("edit-test.messages.json");

let root: string;
let repo: string;
let fake: FakeOpenCodeServer;
let url: string;
const adapters: OpenCodeAdapter[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execa("git", args, { cwd, stdin: "ignore" });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "nexestra-opencode-"));
  repo = path.join(root, "repo");
  await execa("git", ["init", "-q", "-b", "main", repo], { stdin: "ignore" });
  await git(repo, "config", "user.email", "test@nexestra.local");
  await git(repo, "config", "user.name", "nexestra test");
  await writeFile(path.join(repo, "README.md"), "# scratch\n", "utf8");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "initial");
  fake = new FakeOpenCodeServer({ messages: MESSAGES });
  url = await fake.start();
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose().catch(() => {})));
  await fake.stop();
  await rm(root, { recursive: true, force: true });
});

function adapterFor(overrides: OpenCodeAdapterOptions = {}): OpenCodeAdapter {
  const adapter = createOpenCodeAdapter({
    attachUrl: url,
    defaultModel: "openai/gpt-5.4-mini",
    startTimeoutMs: 10_000,
    idleSettleMs: 30,
    abortTimeoutMs: 500,
    ...overrides,
  });
  adapters.push(adapter);
  return adapter;
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

/** Replay the events of one recorded session when the prompt arrives. */
function script(name: OpenCodeSseFixtureName, sessionId?: string): void {
  const source = sessionId ?? OPENCODE_SSE_FIXTURES[name].sessionId;
  fake.configure({
    script: {
      events: eventsForSession(loadSseEvents(name), source, true),
      sourceSessionId: source,
    },
  });
}

function scriptEvents(events: readonly OpenCodeEvent[], sourceSessionId: string): void {
  fake.configure({ script: { events, sourceSessionId } });
}

async function collect(iterable: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function bodyOf(method: string, prefix: string): unknown {
  const request = fake.requests.find(
    (entry) => entry.method === method && entry.url.startsWith(prefix),
  );
  return request ? (JSON.parse(request.body || "{}") as unknown) : undefined;
}

describe("splitModelRef", () => {
  it("splits on the first slash, because model ids contain slashes", () => {
    expect(splitModelRef("openai/gpt-5.4-mini")).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(splitModelRef("9router/dsv4/deepseek-v4-flash-0731")).toEqual({
      providerId: "9router",
      modelId: "dsv4/deepseek-v4-flash-0731",
    });
    expect(splitModelRef("gpt-5.4-mini")).toBeUndefined();
  });
});

describe("prepare", () => {
  it("creates the run directory, the manifest and the session", async () => {
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    expect(prepared.harness).toBe("opencode");
    expect(prepared.cwd).toBe(repo);
    expect(prepared.worktreePath).toBe(repo);
    expect(prepared.args).toContain("--print-logs");
    expect(prepared.instructionsPath).toContain(
      path.join(".nexestra", "runs", prepared.runId, "instructions.md"),
    );
    expect(await readFile(prepared.instructionsPath ?? "", "utf8")).toBe(
      "Add a function add(a, b).",
    );
    const manifest = JSON.parse(
      await readFile(path.join(repo, ".nexestra", "runs", prepared.runId, "run.json"), "utf8"),
    ) as { sessionId: string; agent: string; modelId: string };
    expect(manifest.sessionId).toMatch(/^ses_/);
    expect(manifest.agent).toBe("build");
    expect(manifest.modelId).toBe("gpt-5.4-mini");
  });

  it("sends the task id as the title and the sandbox as a permission ruleset", async () => {
    const adapter = adapterFor();
    await adapter.prepare(spec({ taskId: "task_42", sandbox: "read-only" }));
    const body = bodyOf("POST", "/session") as {
      title: string;
      agent: string;
      model: { providerID: string; id: string };
      permission: OpenCodePermissionRuleset;
    };
    expect(body.title).toBe("task_42");
    expect(body.model).toEqual({ providerID: "openai", id: "gpt-5.4-mini" });
    expect(body.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(body.permission).toContainEqual({ permission: "read", pattern: "*", action: "allow" });
  });

  it("maps reasoning onto the model variant", async () => {
    const adapter = adapterFor();
    await adapter.prepare(spec({ reasoning: "xhigh" }));
    const body = bodyOf("POST", "/session") as { model: { variant?: string } };
    expect(body.model.variant).toBe("max");
  });

  it("never copies process.env into the PreparedRun", async () => {
    const adapter = adapterFor({ env: { FOO: "bar" } });
    const prepared = await adapter.prepare(spec());
    expect(Object.keys(prepared.env)).toEqual(["FOO"]);
  });

  it("rejects a relative cwd", async () => {
    const adapter = adapterFor();
    await expect(adapter.prepare(spec({ cwd: "relative" }))).rejects.toThrow(/must be absolute/);
  });

  it("rejects a model without a provider prefix", async () => {
    const adapter = adapterFor();
    await expect(adapter.prepare(spec({ model: "gpt-5.4-mini" }))).rejects.toThrow(
      /no provider prefix/,
    );
  });
});

describe("run", () => {
  it("streams the whole recorded turn and ends with final + ended", async () => {
    script("edit-test.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));

    for (const event of events) expect(HarnessEventSchema.parse(event)).toEqual(event);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("started");
    expect(types.at(-1)).toBe("ended");
    expect(types.at(-2)).toBe("final");
    expect(events[0]).toEqual({
      type: "started",
      sessionRef: prepared.runId ? expect.any(String) : "",
    });
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });

    const final = events.find((event) => event.type === "final");
    expect(final?.message).toMatch(/^Added `add\(a, b\)`/);
    const structured = final?.structured as {
      usage: { steps: number; inputTokens: number };
      patches: { tool: string }[];
      fileChanges: { path: string }[];
      diff: { base: string; files: unknown[] };
      model: string;
      finish: string;
    };
    expect(structured.usage.steps).toBe(5);
    expect(structured.usage.inputTokens).toBe(11_267);
    expect(structured.patches[0]?.tool).toBe("apply_patch");
    // The recording was made under /WORK/repo, so its absolute `file.edited`
    // paths stay absolute here; the tool metadata's relative ones do not.
    expect(structured.fileChanges.map((file) => file.path)).toContain("src/math.ts");
    expect(structured.fileChanges.map((file) => file.path)).toContain("src/math.test.ts");
    expect(structured.model).toBe("openai/gpt-5.4-mini");
    expect(structured.finish).toBe("stop");
    // The real diff of the worktree, not the harness' word for it.
    expect(structured.diff.base).toBe("HEAD");
  });

  it("sends the prompt asynchronously with the model, agent and tools", async () => {
    script("edit-test.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec({ sandbox: "read-only", tools: ["read"] }));
    await collect(adapter.run(prepared, new AbortController().signal));
    const body = bodyOf("POST", "/session/") as {
      parts: { type: string; text: string }[];
      agent: string;
      model: { providerID: string; modelID: string };
      tools: Record<string, boolean>;
    };
    expect(body.parts).toEqual([{ type: "text", text: "Add a function add(a, b)." }]);
    expect(body.agent).toBe("build");
    expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-5.4-mini" });
    expect(body.tools).toMatchObject({ read: true, bash: false, edit: false });
  });

  it("subscribes to the event stream before prompting", async () => {
    script("edit-test.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    await collect(adapter.run(prepared, new AbortController().signal));
    const eventIndex = fake.requests.findIndex((entry) => entry.url.startsWith("/event"));
    const promptIndex = fake.requests.findIndex((entry) => entry.url.includes("/prompt_async"));
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(eventIndex).toBeLessThan(promptIndex);
  });

  it("opens exactly one SSE connection per server, whatever the run count", async () => {
    script("edit-test.event-v1");
    const adapter = adapterFor();
    const first = await adapter.prepare(spec());
    await collect(adapter.run(first, new AbortController().signal));
    const second = await adapter.prepare(spec());
    await collect(adapter.run(second, new AbortController().signal));
    expect(fake.requests.filter((entry) => entry.url.startsWith("/event"))).toHaveLength(1);
  });

  it("reports a provider failure as a retryable error, with no final", async () => {
    script("edit-test.event-v1", API_ERROR_SESSION_ID);
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const types = events.map((event) => event.type);
    expect(types).not.toContain("final");
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
    expect(events.find((event) => event.type === "error")).toMatchObject({
      retryable: true,
      message: expect.stringContaining("APIError"),
    });
  });

  it("maps an abort to error(cancelled) + ended, without a final", async () => {
    script("abort.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    expect(events.map((event) => event.type)).not.toContain("final");
    expect(events).toContainEqual({ type: "error", message: "cancelled", retryable: false });
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
  });

  it("aborts the session when the caller's signal fires", async () => {
    // A run that goes busy and then never finishes on its own.
    scriptEvents(
      [{ type: "session.status", properties: { sessionID: "ses_src", status: { type: "busy" } } }],
      "ses_src",
    );
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    const controller = new AbortController();
    const events: HarnessEvent[] = [];
    for await (const event of adapter.run(prepared, controller.signal)) {
      events.push(event);
      if (event.type === "started") setTimeout(() => controller.abort(), 20);
    }
    expect(fake.requests.some((entry) => entry.url.includes("/abort"))).toBe(true);
    // The session is verified idle before the run is declared over.
    expect(fake.requests.some((entry) => entry.url.startsWith("/session/status"))).toBe(true);
    expect(events).toContainEqual({ type: "error", message: "cancelled", retryable: false });
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
    expect(events.map((event) => event.type)).not.toContain("final");
  });

  it("gives up with a retryable error when the run outlives its timeout", async () => {
    scriptEvents(
      [{ type: "session.status", properties: { sessionID: "ses_src", status: { type: "busy" } } }],
      "ses_src",
    );
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec({ timeoutMs: 60 }));
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    expect(events).toContainEqual({
      type: "error",
      message: "timeout after 60ms",
      retryable: true,
    });
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 1 });
  });

  it("surfaces a rejected prompt without hanging", async () => {
    fake.configure({ promptStatus: 400 });
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    expect(events.map((event) => event.type)).toEqual(["started", "error", "ended"]);
    expect(events[1]).toMatchObject({ retryable: false });
  });

  it("refuses a PreparedRun from another harness", async () => {
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    await expect(
      collect(adapter.run({ ...prepared, harness: "codex" }, new AbortController().signal)),
    ).rejects.toThrow(/expected "opencode"/);
  });

  it("reloads a run prepared by an earlier process from its manifest", async () => {
    script("edit-test.event-v1");
    const first = adapterFor();
    const prepared = await first.prepare(spec());
    const second = adapterFor();
    const events = await collect(second.run(prepared, new AbortController().signal));
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });
  });
});

describe("permissions", () => {
  it("raises a request and answers it on the session-scoped route", async () => {
    script("permission.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
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
    const request = events.find((event) => event.type === "permission_request");
    expect(request?.requestId).toBe("per_05fa2d22d00158GgZ4FbiGCDKh");
    const reply = fake.requests.find((entry) => entry.url.includes("/permissions/"));
    expect(reply?.body).toBe('{"response":"once"}');
    expect(events.at(-1)).toEqual({ type: "ended", exitCode: 0 });
  });

  it("rejects when the approval is denied and upgrades to always on request", async () => {
    script("permission.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    const iterator = adapter.run(prepared, new AbortController().signal);
    for await (const event of iterator) {
      if (event.type !== "permission_request") continue;
      await adapter.control(prepared.runId, {
        action: "answer_permission",
        requestId: event.requestId,
        approved: false,
      });
      await adapter.control(prepared.runId, {
        action: "answer_permission",
        requestId: event.requestId,
        approved: true,
        note: "always",
      });
    }
    const replies = fake.requests
      .filter((entry) => entry.url.includes("/permissions/"))
      .map((entry) => entry.body);
    expect(replies).toEqual(['{"response":"reject"}', '{"response":"always"}']);
  });
});

describe("control", () => {
  it("aborts a session that is not streaming", async () => {
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    const result = await adapter.controlDetailed(prepared.runId, {
      action: "cancel",
      reason: "user cancelled",
    });
    expect(result).toMatchObject({ action: "cancel", supported: true, applied: true });
    expect(fake.requests.some((entry) => entry.url.includes("/abort"))).toBe(true);
  });

  it("steers by sending another prompt into the same session", async () => {
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    await adapter.control(prepared.runId, { action: "steer", message: "also update the README" });
    const prompts = fake.requests.filter((entry) => entry.url.includes("/prompt_async"));
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(prompts[0]?.body ?? "{}")).toMatchObject({
      parts: [{ type: "text", text: "also update the README" }],
    });
  });

  it("reports pause and resume as unsupported", async () => {
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec());
    await expect(adapter.control(prepared.runId, { action: "pause" })).rejects.toBeInstanceOf(
      OpenCodeUnsupportedControlError,
    );
    const result = await adapter.controlDetailed(prepared.runId, { action: "resume" });
    expect(result).toMatchObject({ supported: false });
  });

  it("does not throw for an unknown run id", async () => {
    const adapter = adapterFor();
    const result = await adapter.controlDetailed("run_missing", { action: "cancel" });
    expect(result).toMatchObject({ supported: true, applied: false });
  });
});

describe("review mode", () => {
  it("runs the reviewer read-only and parses the findings", async () => {
    fake.configure({
      messages: [
        {
          info: { id: "msg_1", role: "assistant", sessionID: "ses_fake1" },
          parts: [
            {
              type: "text",
              text: [
                "Reviewed the diff.",
                "```json",
                '{"summary":"one issue","findings":[{"title":"Missing guard","severity":"high",',
                '"file":"src/math.ts","line":3,"body":"add() does not validate its inputs."}]}',
                "```",
              ].join("\n"),
            },
          ],
        },
      ],
    });
    script("edit-test.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(
      spec({ kind: "review", sandbox: "workspace-write", instructions: "Review the change." }),
    );

    const create = bodyOf("POST", "/session") as {
      agent: string;
      permission: OpenCodePermissionRuleset;
    };
    // The reviewer must not be able to edit what it reviews.
    expect(create.agent).toBe("plan");
    expect(create.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });

    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const prompt = JSON.parse(
      fake.requests.find((entry) => entry.url.includes("/prompt_async"))?.body ?? "{}",
    ) as { parts: { text: string }[] };
    expect(prompt.parts[0]?.text).toContain("Review the change.");
    expect(prompt.parts[0]?.text).toContain("```json");

    const final = events.find((event) => event.type === "final");
    const structured = final?.structured as {
      findings: { title: string; severity: string }[];
      reviewSummary: string;
      warnings?: string[];
    };
    expect(structured.findings).toEqual([
      {
        title: "Missing guard",
        severity: "high",
        file: "src/math.ts",
        line: 3,
        body: "add() does not validate its inputs.",
      },
    ]);
    expect(structured.reviewSummary).toBe("one issue");
    expect(structured.warnings?.join(" ")).toContain("forced to read-only");
  });

  it("keeps the prose answer and an empty findings list when the model ignores the format", async () => {
    fake.configure({
      messages: [
        {
          info: { id: "msg_1", role: "assistant" },
          parts: [{ type: "text", text: "Looks fine to me." }],
        },
      ],
    });
    script("edit-test.event-v1");
    const adapter = adapterFor();
    const prepared = await adapter.prepare(spec({ kind: "review", sandbox: "read-only" }));
    const events = await collect(adapter.run(prepared, new AbortController().signal));
    const final = events.find((event) => event.type === "final");
    expect(final?.message).toBe("Looks fine to me.");
    const structured = final?.structured as { findings: unknown[] } | undefined;
    expect(structured?.findings).toEqual([]);
  });
});
