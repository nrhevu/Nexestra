import { HarnessEventSchema } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import { CodexStreamParser, classifyCodexError } from "./parser.js";
import { CODEX_FIXTURE_NAMES, chunked, loadFixture } from "./test-support.js";

function replay(name: string, options: { chunkSize?: number } = {}) {
  const fixture = loadFixture(name);
  const parser = new CodexStreamParser({
    cwd: fixture.meta.cwd,
    hasOutputSchema: fixture.meta.outputSchema !== undefined,
  });
  const events = [];
  for (const chunk of chunked(fixture.jsonl, options.chunkSize ?? fixture.jsonl.length)) {
    events.push(...parser.push(chunk));
  }
  events.push(...parser.flush());
  return { fixture, parser, events };
}

describe("every recorded fixture replays without throwing", () => {
  for (const name of CODEX_FIXTURE_NAMES) {
    it(`${name} produces only valid HarnessEvents`, () => {
      const { events, parser } = replay(name);
      for (const event of events) {
        expect(() => HarnessEventSchema.parse(event)).not.toThrow();
      }
      expect(parser.state.malformedLines).toBe(0);
      expect(parser.state.unknownLines).toBe(0);
    });

    it(`${name} is chunk-size independent`, () => {
      const whole = replay(name).events;
      for (const chunkSize of [1, 7, 64, 997]) {
        expect(replay(name, { chunkSize }).events).toEqual(whole);
      }
    });
  }
});

describe("exec-edit-test — the happy path", () => {
  it("maps the stream onto the documented event sequence", () => {
    const { events, parser } = replay("exec-edit-test");
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
    ]);
    expect(events[0]).toEqual({
      type: "started",
      sessionRef: "01a05f9b-e3c8-7ad0-83e5-03cdec224903",
    });
    expect(parser.threadId).toBe("01a05f9b-e3c8-7ad0-83e5-03cdec224903");
    expect(parser.state.turnCompleted).toBe(true);
    expect(parser.state.turnFailed).toBe(false);
  });

  it("reports usage from turn.completed only", () => {
    const { events } = replay("exec-edit-test");
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toEqual({ type: "usage", inputTokens: 56396, outputTokens: 448 });
  });

  it("keeps the full Codex token breakdown in parser state", () => {
    const { parser } = replay("exec-edit-test");
    expect(parser.state.usage).toEqual({
      input_tokens: 56396,
      cached_input_tokens: 47360,
      cache_write_input_tokens: 0,
      output_tokens: 448,
      reasoning_output_tokens: 59,
    });
  });

  it("emits a command on item.started and again with exit code on item.completed", () => {
    const { events } = replay("exec-edit-test");
    const commands = events.filter((event) => event.type === "command");
    expect(commands[0]?.exitCode).toBeUndefined();
    expect(commands[0]?.stdout).toBeUndefined();
    expect(commands[1]?.exitCode).toBe(0);
    // stdout and stderr are merged by Codex; stderr stays undefined.
    expect(commands[1]?.stdout).toContain("export function mul");
    expect(commands[1]?.stderr).toBeUndefined();
    expect(commands[0]?.cmd).toBe(commands[1]?.cmd);
  });

  it("extracts the final assistant message", () => {
    const { parser } = replay("exec-edit-test");
    expect(parser.lastAgentMessage).toContain("add(a, b)");
  });
});

describe("exec-output-schema — file changes and structured output", () => {
  it("fans file_change.changes[] out to one file_changed each, relativised", () => {
    const { events } = replay("exec-output-schema");
    const changes = events.filter((event) => event.type === "file_changed");
    expect(changes).toEqual([
      { type: "file_changed", path: "src/math.test.ts", kind: "modify" },
      { type: "file_changed", path: "src/math.ts", kind: "modify" },
    ]);
  });

  it("emits file_changed only once, on item.completed", () => {
    const { events } = replay("exec-output-schema");
    expect(events.filter((event) => event.type === "file_changed")).toHaveLength(2);
  });

  it("keeps absolute paths when relativisePaths is off", () => {
    const fixture = loadFixture("exec-output-schema");
    const parser = new CodexStreamParser({ cwd: fixture.meta.cwd, relativisePaths: false });
    const events = parser.pushAll(fixture.jsonl);
    const first = events.find((event) => event.type === "file_changed");
    expect(first?.path).toBe("/WORK/codex-b/src/math.test.ts");
  });

  it("parses the JSON string in the final agent_message", () => {
    const { parser } = replay("exec-output-schema");
    expect(parser.parseStructuredOutput()).toEqual({
      summary:
        "Added `add(a, b)` and its test. `node --test src/*.test.ts` passes: 2 tests, 0 failures.",
      status: "ok",
      filesChanged: ["src/math.ts", "src/math.test.ts"],
    });
  });

  it("returns undefined structured output when no schema was requested", () => {
    const fixture = loadFixture("exec-output-schema");
    const parser = new CodexStreamParser({ cwd: fixture.meta.cwd, hasOutputSchema: false });
    parser.pushAll(fixture.jsonl);
    expect(parser.parseStructuredOutput()).toBeUndefined();
  });
});

describe("exec-read-only-question", () => {
  it("reports the recorded usage", () => {
    const { events } = replay("exec-read-only-question");
    expect(events.at(-1)).toEqual({ type: "usage", inputTokens: 40273, outputTokens: 160 });
  });
});

describe("exec-review-uncommitted", () => {
  it("maps todo_list onto a tool_call plus one tool_result per update", () => {
    const { events, parser } = replay("exec-review-uncommitted");
    const calls = events.filter((event) => event.type === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("todo_list");
    const results = events.filter((event) => event.type === "tool_result");
    // two item.updated plus the final item.completed
    expect(results).toHaveLength(3);
    expect(results.every((event) => event.callId === calls[0]?.callId)).toBe(true);
    expect(parser.state.todos).toHaveLength(3);
    expect(parser.state.todos.every((todo) => todo.completed)).toBe(true);
  });

  it("surfaces the all-zero review usage verbatim", () => {
    const { events } = replay("exec-review-uncommitted");
    const usage = events.filter((event) => event.type === "usage");
    expect(usage[0]).toEqual({ type: "usage", inputTokens: 0, outputTokens: 0 });
  });
});

describe("exec-cancelled-sigint", () => {
  it("stops after turn.started with no terminal event", () => {
    const { events, parser } = replay("exec-cancelled-sigint");
    expect(events.map((event) => event.type)).toEqual(["started"]);
    expect(parser.state.turnStarted).toBe(true);
    expect(parser.state.turnCompleted).toBe(false);
    expect(parser.lastAgentMessage).toBeUndefined();
  });
});

describe("exec-truncated-sighup", () => {
  it("parses the orphaned run's stream without throwing", () => {
    const { events, parser } = replay("exec-truncated-sighup");
    expect(events[0]?.type).toBe("started");
    expect(parser.state.fileChanges).toHaveLength(2);
    expect(parser.state.malformedLines).toBe(0);
  });
});

describe("truncated and malformed input", () => {
  it("drops a half-written trailing line instead of throwing", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      '{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"id":"i1","type":"agent_me',
    );
    expect(events.map((event) => event.type)).toEqual(["started"]);
    expect(parser.state.malformedLines).toBe(1);
    expect(parser.state.truncatedTail).toContain("agent_me");
  });

  it("recovers a complete trailing line without a final newline", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}',
    );
    expect(events.map((event) => event.type)).toEqual(["started", "usage"]);
    expect(parser.state.malformedLines).toBe(0);
  });

  it("skips garbage lines and blank lines", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      `${[
        "not json at all",
        "",
        "   ",
        "[1,2,3]",
        '{"type":"thread.started","thread_id":"t1"}',
      ].join("\n")}\n`,
    );
    expect(events.map((event) => event.type)).toEqual(["started"]);
    expect(parser.state.malformedLines).toBe(2);
  });

  it("handles CRLF line endings", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll('{"type":"thread.started","thread_id":"t1"}\r\n');
    expect(events).toEqual([{ type: "started", sessionRef: "t1" }]);
  });
});

describe("unknown events are logged and skipped", () => {
  it("skips unknown top-level types", () => {
    const warnings: string[] = [];
    const parser = new CodexStreamParser({
      logger: { debug: (message) => warnings.push(message), warn: () => {} },
    });
    const events = parser.pushAll(
      `${[
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"turn.interrupted","reason":"whatever"}',
        '{"type":"session.next.text.delta","delta":"hi"}',
        '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
      ].join("\n")}\n`,
    );
    expect(events.map((event) => event.type)).toEqual(["started", "usage"]);
    expect(parser.state.unknownLines).toBe(2);
    expect(warnings.some((message) => message.includes("unknown event type"))).toBe(true);
  });

  it("skips unknown item types", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      `${[
        '{"type":"item.completed","item":{"id":"i1","type":"image_generation","url":"x"}}',
        '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"ok"}}',
        '{"type":"item.started"}',
      ].join("\n")}\n`,
    );
    expect(events.map((event) => event.type)).toEqual(["assistant_text"]);
    expect(parser.state.unknownLines).toBe(2);
  });
});

describe("event kinds that were typed but never recorded", () => {
  it("maps reasoning items", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      '{"type":"item.completed","item":{"id":"r1","type":"reasoning","text":"thinking"}}\n',
    );
    expect(events).toEqual([{ type: "reasoning", text: "thinking" }]);
  });

  it("maps mcp_tool_call to tool_call plus tool_result", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      `${[
        '{"type":"item.started","item":{"id":"m1","type":"mcp_tool_call","server":"fs","tool":"read","arguments":{"path":"a"},"status":"in_progress"}}',
        '{"type":"item.completed","item":{"id":"m1","type":"mcp_tool_call","server":"fs","tool":"read","result":{"content":"x"},"status":"completed"}}',
      ].join("\n")}\n`,
    );
    expect(events).toEqual([
      { type: "tool_call", name: "fs/read", input: { path: "a" }, callId: "m1" },
      { type: "tool_result", callId: "m1", output: { content: "x" }, ok: true },
    ]);
  });

  it("marks a failed mcp_tool_call as not ok and returns the error", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      '{"type":"item.completed","item":{"id":"m2","type":"mcp_tool_call","server":"fs","tool":"read","error":{"message":"nope"},"status":"failed"}}\n',
    );
    expect(events).toEqual([
      { type: "tool_result", callId: "m2", output: { message: "nope" }, ok: false },
    ]);
  });

  it("maps an error item and a turn.failed line", () => {
    const parser = new CodexStreamParser();
    const events = parser.pushAll(
      `${[
        '{"type":"item.completed","item":{"id":"e1","type":"error","message":"disk full"}}',
        '{"type":"turn.failed","error":{"message":"stream disconnected"}}',
        '{"type":"error","message":"429 rate limit exceeded"}',
      ].join("\n")}\n`,
    );
    expect(events).toEqual([
      { type: "error", message: "disk full", retryable: false },
      { type: "error", message: "stream disconnected", retryable: true },
      { type: "error", message: "429 rate limit exceeded", retryable: true },
    ]);
    expect(parser.state.turnFailed).toBe(true);
  });

  it("maps file_change kinds add and delete", () => {
    const parser = new CodexStreamParser({ cwd: "/w" });
    const events = parser.pushAll(
      '{"type":"item.completed","item":{"id":"f1","type":"file_change","status":"completed","changes":[{"path":"/w/a.ts","kind":"add"},{"path":"/w/b.ts","kind":"delete"},{"path":"/w/c.ts","kind":"update"},{"path":"/w/d.ts","kind":"brand-new-kind"}]}}\n',
    );
    expect(events).toEqual([
      { type: "file_changed", path: "a.ts", kind: "add" },
      { type: "file_changed", path: "b.ts", kind: "delete" },
      { type: "file_changed", path: "c.ts", kind: "modify" },
      { type: "file_changed", path: "d.ts", kind: "modify" },
    ]);
  });

  it("keeps paths outside the run cwd absolute", () => {
    const parser = new CodexStreamParser({ cwd: "/w" });
    const events = parser.pushAll(
      '{"type":"item.completed","item":{"id":"f2","type":"file_change","changes":[{"path":"/elsewhere/x.ts","kind":"add"}]}}\n',
    );
    expect(events[0]).toMatchObject({ path: "/elsewhere/x.ts" });
  });
});

describe("classifyCodexError", () => {
  it("marks transport failures retryable", () => {
    expect(classifyCodexError("stream disconnected before completion")).toBe(true);
    expect(classifyCodexError("request timed out")).toBe(true);
    expect(classifyCodexError("connect ECONNRESET 1.2.3.4:443")).toBe(true);
    expect(classifyCodexError("503 service unavailable")).toBe(true);
  });

  it("marks auth, quota and CLI misuse fatal", () => {
    expect(classifyCodexError("401 unauthorized")).toBe(false);
    expect(classifyCodexError("You are not logged in")).toBe(false);
    expect(classifyCodexError("usage limit reached, please retry later")).toBe(false);
    expect(classifyCodexError("error: unexpected argument '--nope' found")).toBe(false);
  });

  it("defaults to not retryable", () => {
    expect(classifyCodexError("something unfamiliar happened")).toBe(false);
  });
});
