/**
 * The handover between global setup, the test workers and global teardown.
 *
 * Workers are separate processes, so anything they need to know about the
 * server global setup started has to go through a file.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { STATE_FILE } from "./paths.js";

export interface E2eState {
  /** Where the server is listening. */
  readonly baseURL: string;
  /** Scratch `NEXESTRA_HOME` — the database and artifacts for this run. */
  readonly home: string;
  /** A throwaway git repository a workspace can be pointed at. */
  readonly repo: string;
  /** Temp root of `repo`, removed by teardown. */
  readonly repoRoot: string;
  /** Where the server's stdout and stderr went. */
  readonly logFile: string;
  /** PID of the server process. */
  readonly pid: number;
  /**
   * True once `apps/server` reads `NEXESTRA_FAKE_HARNESS` — i.e. once the
   * orchestrator is wired in and a run can actually execute. Until then the
   * execution specs skip themselves rather than fail.
   */
  readonly fakeHarnessSupported: boolean;
}

export function writeE2eState(state: E2eState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function readE2eState(): E2eState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as E2eState;
  } catch (error) {
    throw new Error(
      `no e2e state at ${STATE_FILE} — run the suite through \`pnpm e2e\` so global setup runs first (${String(error)})`,
    );
  }
}

export function clearE2eState(): void {
  rmSync(STATE_FILE, { force: true });
}
