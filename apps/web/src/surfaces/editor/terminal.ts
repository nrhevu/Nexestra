import { type HarnessEvent, HarnessEventSchema, type RunEvent } from "@nexestra/core";

/**
 * `RunEvent[]` → terminal lines.
 *
 * A pure function on purpose. The terminal itself is an xterm instance with a
 * DOM node and a resize observer, none of which is worth testing; *what the
 * user reads* is, and this is that. It is also what makes streaming cheap: the
 * pane keeps a cursor into the event list and only writes the tail.
 *
 * Four event types carry the run's story — `command`, `assistant_text`,
 * `tool_call` and `error` — plus `started` / `ended` to frame it. Everything
 * else (reasoning, usage, per-file changes) belongs to the sidebar and the
 * diff, not to a scrollback.
 */

/** SGR colours; xterm renders them, and a plain-text test can ignore them. */
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const GREEN = "\u001b[32m";
const CYAN = "\u001b[36m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";

export interface TerminalOptions {
  /** Emit SGR escapes. Off in tests, on in the pane. */
  readonly colour?: boolean;
}

/** Lines for one event; empty when the event has nothing to show. */
export function linesForRunEvent(event: RunEvent, options: TerminalOptions = {}): string[] {
  const parsed = HarnessEventSchema.safeParse(event.payload);
  if (!parsed.success) return [];
  return linesForHarnessEvent(parsed.data, options);
}

export function linesForHarnessEvent(event: HarnessEvent, options: TerminalOptions = {}): string[] {
  const paint = (colour: string, text: string) =>
    options.colour ? `${colour}${text}${RESET}` : text;

  switch (event.type) {
    case "started":
      return [paint(DIM, `— session ${event.sessionRef} —`)];

    case "command": {
      const lines = [paint(GREEN, `$ ${event.cmd}`)];
      if (event.stdout?.trim()) lines.push(...event.stdout.replace(/\n+$/, "").split("\n"));
      if (event.stderr?.trim()) {
        lines.push(
          ...event.stderr
            .replace(/\n+$/, "")
            .split("\n")
            .map((line) => paint(YELLOW, line)),
        );
      }
      if (event.exitCode !== undefined && event.exitCode !== 0) {
        lines.push(paint(RED, `exit ${event.exitCode}`));
      }
      return lines;
    }

    case "assistant_text":
      return event.text.trim().length === 0 ? [] : event.text.replace(/\n+$/, "").split("\n");

    case "tool_call":
      return [paint(CYAN, `» ${event.name}${summariseInput(event.input)}`)];

    case "error":
      return [paint(RED, `✗ ${event.message}${event.retryable ? " (retryable)" : ""}`)];

    case "ended":
      return [paint(event.exitCode === 0 ? DIM : RED, `— run ended, exit ${event.exitCode} —`)];

    default:
      return [];
  }
}

/** The whole scrollback for a run. */
export function linesForRunEvents(
  events: readonly RunEvent[],
  options: TerminalOptions = {},
): string[] {
  return events.flatMap((event) => linesForRunEvent(event, options));
}

/** A one-line gloss of a tool input; the full payload belongs in the log. */
function summariseInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return ` ${truncate(input)}`;
  if (typeof input !== "object") return ` ${String(input)}`;

  const record = input as Record<string, unknown>;
  for (const key of ["path", "file", "command", "cmd", "query", "pattern"]) {
    const value = record[key];
    if (typeof value === "string") return ` ${truncate(value)}`;
  }
  const keys = Object.keys(record);
  return keys.length === 0 ? "" : ` {${keys.slice(0, 4).join(", ")}}`;
}

function truncate(value: string, max = 120): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
