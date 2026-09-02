import type { HarnessEvent, RunEvent } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import { linesForRunEvent, linesForRunEvents } from "./terminal.js";

let seq = 0;
const event = (payload: HarnessEvent): RunEvent => ({
  id: `rev_${seq}`,
  workspaceId: "ws_1",
  threadId: "th_1",
  runId: "run_1",
  seq: seq++,
  type: payload.type,
  payload,
  createdAt: "2026-09-02T10:00:00.000Z",
});

describe("the run terminal reducer", () => {
  it("renders a command with its output and a non-zero exit", () => {
    const lines = linesForRunEvent(
      event({
        type: "command",
        cmd: "pnpm test",
        exitCode: 1,
        stdout: "1 passing\n1 failing\n",
        stderr: "AssertionError\n",
      }),
    );

    expect(lines).toEqual(["$ pnpm test", "1 passing", "1 failing", "AssertionError", "exit 1"]);
  });

  it("keeps a successful command quiet about its exit code", () => {
    const lines = linesForRunEvent(
      event({ type: "command", cmd: "git status", exitCode: 0, stdout: "clean\n" }),
    );
    expect(lines).toEqual(["$ git status", "clean"]);
  });

  it("summarises a tool call by its most telling argument", () => {
    expect(
      linesForRunEvent(
        event({
          type: "tool_call",
          name: "write_file",
          callId: "c1",
          input: { path: "src/index.ts", contents: "…" },
        }),
      ),
    ).toEqual(["» write_file src/index.ts"]);

    expect(
      linesForRunEvent(
        event({ type: "tool_call", name: "mystery", callId: "c2", input: { a: 1, b: 2 } }),
      ),
    ).toEqual(["» mystery {a, b}"]);
  });

  it("marks an error and says whether it will be retried", () => {
    expect(
      linesForRunEvent(event({ type: "error", message: "rate limited", retryable: true })),
    ).toEqual(["✗ rate limited (retryable)"]);
    expect(
      linesForRunEvent(event({ type: "error", message: "refused", retryable: false })),
    ).toEqual(["✗ refused"]);
  });

  it("splits assistant text into lines and drops empty ones", () => {
    expect(linesForRunEvent(event({ type: "assistant_text", text: "one\ntwo\n" }))).toEqual([
      "one",
      "two",
    ]);
    expect(linesForRunEvent(event({ type: "assistant_text", text: "   " }))).toEqual([]);
  });

  it("shows nothing for the events that belong to other panes", () => {
    expect(linesForRunEvent(event({ type: "reasoning", text: "thinking" }))).toEqual([]);
    expect(linesForRunEvent(event({ type: "usage", inputTokens: 10, outputTokens: 2 }))).toEqual(
      [],
    );
    expect(linesForRunEvent(event({ type: "file_changed", path: "a.ts", kind: "add" }))).toEqual(
      [],
    );
  });

  it("ignores a payload that is not a HarnessEvent", () => {
    const broken: RunEvent = { ...event({ type: "ended", exitCode: 0 }), payload: { nope: true } };
    expect(linesForRunEvent(broken)).toEqual([]);
  });

  it("frames a whole run between its session and its exit", () => {
    const lines = linesForRunEvents([
      event({ type: "started", sessionRef: "codex-abc" }),
      event({ type: "assistant_text", text: "working" }),
      event({ type: "ended", exitCode: 0 }),
    ]);
    expect(lines).toEqual(["— session codex-abc —", "working", "— run ended, exit 0 —"]);
  });

  it("emits SGR escapes only when colour is asked for", () => {
    const plain = linesForRunEvent(event({ type: "error", message: "boom", retryable: false }));
    const coloured = linesForRunEvent(event({ type: "error", message: "boom", retryable: false }), {
      colour: true,
    });
    expect(plain[0]).not.toContain("");
    expect(coloured[0]).toBe("[31m✗ boom[0m");
  });
});
