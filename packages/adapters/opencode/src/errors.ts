import type { RunControl } from "@nexestra/core";

/** `discover()` could not locate or interrogate the `opencode` binary. */
export class OpenCodeDiscoveryError extends Error {
  override readonly name = "OpenCodeDiscoveryError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** `prepare()` refused to build a session for this `RunSpec`. */
export class OpenCodePrepareError extends Error {
  override readonly name = "OpenCodePrepareError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** `run()` was handed a `PreparedRun` this adapter cannot execute. */
export class OpenCodeRunError extends Error {
  override readonly name = "OpenCodeRunError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** `opencode serve` did not start, died, or stopped answering `/global/health`. */
export class OpenCodeServerError extends Error {
  override readonly name = "OpenCodeServerError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** A non-2xx answer from the OpenCode HTTP API. */
export class OpenCodeHttpError extends Error {
  override readonly name = "OpenCodeHttpError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} failed with HTTP ${status}${body ? `: ${truncate(body, 400)}` : ""}`);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export type OpenCodeControlAction = RunControl["action"];

/** Thrown by `control()` for actions OpenCode has no channel for (`pause`). */
export class OpenCodeUnsupportedControlError extends Error {
  override readonly name = "OpenCodeUnsupportedControlError";
  readonly harness = "opencode" as const;
  constructor(
    readonly action: OpenCodeControlAction,
    readonly reason: string,
  ) {
    super(`opencode does not support control action "${action}": ${reason}`);
  }
}

/** Result of `OpenCodeAdapter.controlDetailed()`. */
export type OpenCodeControlResult =
  | { action: OpenCodeControlAction; supported: true; applied: boolean; note?: string }
  | { action: OpenCodeControlAction; supported: false; reason: string };
