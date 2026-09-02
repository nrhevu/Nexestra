import type { RunControl } from "@nexestra/core";

/** `prepare()` refused to build a command line for this `RunSpec`. */
export class CodexPrepareError extends Error {
  override readonly name = "CodexPrepareError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** `discover()` could not locate or interrogate the `codex` binary. */
export class CodexDiscoveryError extends Error {
  override readonly name = "CodexDiscoveryError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

/** `run()` was handed a `PreparedRun` this adapter cannot execute. */
export class CodexRunError extends Error {
  override readonly name = "CodexRunError";
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export type CodexControlAction = RunControl["action"];

/**
 * Thrown by `control()` for the actions `codex exec` has no channel for.
 * `controlDetailed()` returns the same information without throwing.
 */
export class CodexUnsupportedControlError extends Error {
  override readonly name = "CodexUnsupportedControlError";
  readonly harness = "codex" as const;
  /** What Codex surface would be needed to implement this action. */
  readonly requires = "app-server" as const;
  constructor(
    readonly action: CodexControlAction,
    readonly reason: string,
  ) {
    super(`codex exec does not support control action "${action}": ${reason}`);
  }
}

/** Result of `CodexAdapter.controlDetailed()`. */
export type CodexControlResult =
  | { action: CodexControlAction; supported: true; applied: boolean; note?: string }
  | {
      action: CodexControlAction;
      supported: false;
      reason: string;
      requires: "app-server";
    };
