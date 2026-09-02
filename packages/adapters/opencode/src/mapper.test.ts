import { type HarnessEvent, HarnessEventSchema } from "@nexestra/core";
import { describe, expect, it } from "vitest";
import { OpenCodeMapper } from "./mapper.js";
import {
  API_ERROR_SESSION_ID,
  eventsForSession,
  loadSseEvents,
  OPENCODE_SSE_FIXTURES,
  type OpenCodeSseFixtureName,
} from "./test-support.js";
import type { OpenCodeEvent } from "./types.js";

const WORKTREE = "/WORK/repo";

interface Replay {
  events: HarnessEvent[];
  mapper: OpenCodeMapper;
}

function replay(
  name: OpenCodeSseFixtureName,
  sessionId: string,
  options: { sessionless?: boolean; streamDeltas?: boolean } = {},
): Replay {
  const mapper = new OpenCodeMapper({
    sessionId,
    cwd: WORKTREE,
    ...(options.streamDeltas ? { streamDeltas: true } : {}),
  });
  const events: HarnessEvent[] = [];
  for (const event of eventsForSession(
    loadSseEvents(name),
    sessionId,
    options.sessionless ?? false,
  )) {
    events.push(...mapper.push(event));
  }
  events.push(...mapper.flushPending());
  return { events, mapper };
}

function types(events: readonly HarnessEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("every recorded stream", () => {
  it("maps to events that satisfy the HarnessEvent schema and never throws", () => {
    for (const name of Object.keys(OPENCODE_SSE_FIXTURES) as OpenCodeSseFixtureName[]) {
      const fixture = OPENCODE_SSE_FIXTURES[name];
      for (const sessionId of [fixture.sessionId, API_ERROR_SESSION_ID]) {
        const { events } = replay(name, sessionId, { sessionless: true });
        for (const event of events) {
          expect(HarnessEventSchema.parse(event), `${name}/${sessionId}`).toEqual(event);
        }
      }
    }
  });

  it("recognises every event type the 1.18.25 server emitted", () => {
    for (const name of Object.keys(OPENCODE_SSE_FIXTURES) as OpenCodeSseFixtureName[]) {
      const { mapper } = replay(name, OPENCODE_SSE_FIXTURES[name].sessionId, {
        sessionless: true,
      });
      // Known-but-unmapped events (heartbeats, plugin registrations) are fine;
      // a type outside the recorded union would mean the protocol moved.
      expect(mapper.state.unknownEvents, name).toBe(0);
    }
  });
});

describe("the successful edit+test run", () => {
  const sessionId = OPENCODE_SSE_FIXTURES["edit-test.event-v1"].sessionId;

  it("emits the whole turn in order", () => {
    const { events } = replay("edit-test.event-v1", sessionId);
    expect(types(events)).toEqual([
      "reasoning",
      "assistant_text",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "usage",
      "reasoning",
      "tool_call",
      "tool_call",
      "tool_result",
      "tool_result",
      "usage",
      "reasoning",
      "assistant_text",
      "tool_call",
      "tool_result",
      "file_changed",
      "file_changed",
      "usage",
      "reasoning",
      "tool_call",
      "tool_result",
      "command",
      "usage",
      "reasoning",
      "assistant_text",
      "usage",
    ]);
  });

  it("handles the five assistant messages of one prompt", () => {
    // §2.4: one prompt produces one assistant message per model step, and the
    // synchronous POST response would only have contained the last of them.
    const { mapper } = replay("edit-test.event-v1", sessionId);
    expect(mapper.state.assistantMessageIds).toHaveLength(5);
    expect(mapper.lastAssistantText).toMatch(/^Added `add\(a, b\)`/);
    expect(mapper.state.finish).toBe("stop");
  });

  it("accumulates one usage event per step-finish and the totals", () => {
    const { events, mapper } = replay("edit-test.event-v1", sessionId);
    const usage = events.filter((event) => event.type === "usage");
    expect(usage).toHaveLength(5);
    expect(usage[0]).toEqual({
      type: "usage",
      inputTokens: 9166,
      outputTokens: 97,
      costUSD: 0,
    });
    const totals = mapper.state.usage;
    expect(totals.steps).toBe(5);
    expect(totals.inputTokens).toBe(11_267);
    expect(totals.outputTokens).toBe(613);
    expect(totals.reasoningTokens).toBe(98);
    expect(totals.cacheReadTokens).toBe(37_888);
    // Subscription-billed provider: OpenCode reports a real 0, not a missing value.
    expect(totals.costUSD).toBe(0);
  });

  it("turns the bash tool into a command event with the exit code", () => {
    const { events } = replay("edit-test.event-v1", sessionId);
    const command = events.find((event) => event.type === "command");
    expect(command).toMatchObject({
      type: "command",
      cmd: "node --test src/*.test.ts",
      exitCode: 0,
    });
    // stdout and stderr are merged by OpenCode; stderr stays undefined.
    expect(command?.stdout).toContain("pass 2");
    expect(command?.stderr).toBeUndefined();
  });

  it("reports file changes relative to the worktree, once per path", () => {
    const { events, mapper } = replay("edit-test.event-v1", sessionId, { sessionless: true });
    const changed = events.filter((event) => event.type === "file_changed");
    expect(changed.map((event) => event.path)).toEqual(["src/math.ts", "src/math.test.ts"]);
    expect(mapper.state.fileChanges.every((file) => file.kind === "modify")).toBe(true);
  });

  it("keeps the unified diff that only apply_patch metadata carries", () => {
    const { mapper } = replay("edit-test.event-v1", sessionId);
    const patches = mapper.state.patches;
    expect(patches).toHaveLength(1);
    expect(patches[0]?.tool).toBe("apply_patch");
    expect(patches[0]?.diff).toContain("+export function add(a: number, b: number): number {");
  });

  it("does not leak the encrypted reasoning blob", () => {
    const { events } = replay("edit-test.event-v1", sessionId);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain("reasoningEncryptedContent");
    expect(serialised).not.toContain("REDACTED");
  });

  it("never emits the user's own prompt as assistant text", () => {
    const { events } = replay("edit-test.event-v1", sessionId);
    const texts = events.filter((event) => event.type === "assistant_text");
    expect(texts.some((event) => event.text.startsWith("Add a function add(a, b)"))).toBe(false);
  });

  it("ends idle, without an error", () => {
    const { mapper } = replay("edit-test.event-v1", sessionId);
    expect(mapper.state.terminal).toBe("idle");
    expect(mapper.state.failure).toBeUndefined();
    expect(mapper.state.aborted).toBe(false);
  });
});

describe("provider failure", () => {
  it("treats session.status retry as progress, not an error", () => {
    const { events, mapper } = replay("edit-test.event-v1", API_ERROR_SESSION_ID);
    // §2.8: five retries with backoff preceded the failure; none of them is an
    // error as far as Nexestra is concerned.
    expect(mapper.state.retries).toBe(5);
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      type: "error",
      message:
        "APIError: Cannot connect to API: Unable to connect. Is the computer able to access the url?",
      retryable: true,
    });
    expect(mapper.state.terminal).toBe("failed");
  });

  it("reports the same failure once, whether it arrives twice or not", () => {
    // `session.error` and the assistant message's `info.error` carry the same
    // payload; only one HarnessEvent must come out.
    const mapper = new OpenCodeMapper({ sessionId: "ses_x" });
    const error = { name: "APIError", data: { message: "boom", isRetryable: false } };
    const first = mapper.push(event("session.error", { sessionID: "ses_x", error }));
    const second = mapper.push(
      event("message.updated", { info: { id: "msg_1", role: "assistant", error } }),
    );
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("permission cycle", () => {
  const sessionId = OPENCODE_SSE_FIXTURES["permission.event-v1"].sessionId;

  it("raises a permission_request with the request id and the command", () => {
    const { events, mapper } = replay("permission.event-v1", sessionId);
    const request = events.find((event) => event.type === "permission_request");
    expect(request).toEqual({
      type: "permission_request",
      requestId: "per_05fa2d22d00158GgZ4FbiGCDKh",
      description: "bash: node --test src/*.test.ts",
      risk: "high",
    });
    expect(mapper.pendingPermission("per_05fa2d22d00158GgZ4FbiGCDKh")?.channel).toBe("permission");
  });

  it("emits nothing for permission.replied and finishes the run", () => {
    const { events, mapper } = replay("permission.event-v1", sessionId);
    expect(events.filter((event) => event.type === "permission_request")).toHaveLength(1);
    expect(types(events)).toContain("command");
    expect(mapper.state.terminal).toBe("idle");
  });
});

describe("abort", () => {
  const sessionId = OPENCODE_SSE_FIXTURES["abort.event-v1"].sessionId;

  it("maps MessageAbortedError to a non-retryable cancellation", () => {
    const { events, mapper } = replay("abort.event-v1", sessionId);
    expect(events).toContainEqual({ type: "error", message: "cancelled", retryable: false });
    expect(mapper.state.aborted).toBe(true);
    expect(mapper.state.terminal).toBe("aborted");
    // A cancelled run has no final answer.
    expect(types(events)).not.toContain("final");
    expect(mapper.state.failure).toBeUndefined();
  });

  it("stays terminal when the session reports idle twice", () => {
    const { events } = replay("abort.event-v1", sessionId);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
  });
});

describe("the v2 stream", () => {
  it("carries none of the run telemetry, which is why v1 is used", () => {
    // Recorded over the same window as the v1 stream (§2.2).
    const { events } = replay(
      "edit-test.event-v2",
      OPENCODE_SSE_FIXTURES["edit-test.event-v2"].sessionId,
    );
    expect(events).toHaveLength(0);
  });
});

describe("robustness", () => {
  it("skips an event type outside the recorded union and counts it", () => {
    const mapper = new OpenCodeMapper({ sessionId: "ses_x" });
    expect(mapper.push(event("session.future.thing", { sessionID: "ses_x" }))).toEqual([]);
    expect(mapper.state.unknownEvents).toBe(1);
  });

  it("skips a known-but-unmapped type without counting it as unknown", () => {
    const mapper = new OpenCodeMapper({ sessionId: "ses_x" });
    expect(mapper.push(event("session.next.text.delta", { sessionID: "ses_x" }))).toEqual([]);
    expect(mapper.state.unknownEvents).toBe(0);
    expect(mapper.state.ignoredEvents).toBe(1);
  });

  it("survives events with missing or malformed payloads", () => {
    const mapper = new OpenCodeMapper({ sessionId: "ses_x" });
    expect(mapper.push(event("message.part.updated", {}))).toEqual([]);
    expect(mapper.push(event("message.updated", { info: null }))).toEqual([]);
    expect(mapper.push(event("session.status", { status: "busy" }))).toEqual([]);
    expect(mapper.push(event("session.error", { error: 42 }))).toEqual([]);
    expect(mapper.push(event("file.edited", {}))).toEqual([]);
  });

  it("ignores an idle that arrives before the session ever went busy", () => {
    const mapper = new OpenCodeMapper({ sessionId: "ses_x" });
    mapper.push(event("session.idle", { sessionID: "ses_x" }));
    expect(mapper.state.terminal).toBeUndefined();
  });

  it("emits a tool_result even when the running state was missed", () => {
    const mapper = new OpenCodeMapper({ sessionId: "ses_x" });
    const events = mapper.push(
      event("message.part.updated", {
        part: {
          type: "tool",
          tool: "grep",
          callID: "call_1",
          state: { status: "completed", input: { pattern: "x" }, output: "none" },
        },
      }),
    );
    expect(types(events)).toEqual(["tool_call", "tool_result"]);
  });

  it("maps a failed tool to ok:false", () => {
    const mapper = new OpenCodeMapper({ sessionId: "ses_x" });
    const events = mapper.push(
      event("message.part.updated", {
        part: {
          type: "tool",
          tool: "bash",
          callID: "call_2",
          state: { status: "error", input: {}, error: "command not found" },
        },
      }),
    );
    expect(events).toContainEqual({
      type: "tool_result",
      callId: "call_2",
      output: "command not found",
      ok: false,
    });
  });

  it("streams deltas when asked to", () => {
    const sessionId = OPENCODE_SSE_FIXTURES["edit-test.event-v1"].sessionId;
    const { events } = replay("edit-test.event-v1", sessionId, { streamDeltas: true });
    const texts = events.filter((event) => event.type === "assistant_text");
    // 100 deltas across the run, versus 3 completed text parts by default.
    expect(texts.length).toBeGreaterThan(50);
  });

  it("keeps an absolute path that is outside the worktree", () => {
    const mapper = new OpenCodeMapper({ sessionId: "ses_x", cwd: WORKTREE });
    const events = mapper.push(event("file.edited", { file: "/etc/hosts" }));
    expect(events).toEqual([{ type: "file_changed", path: "/etc/hosts", kind: "modify" }]);
  });
});

function event(type: string, properties: Record<string, unknown>): OpenCodeEvent {
  return { type, properties };
}
