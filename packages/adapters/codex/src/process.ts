/**
 * Process-group aware spawning.
 *
 * Codex runs the model's shell commands through `/bin/zsh -lc …`, so a run is a
 * *tree* of processes. A recorded run whose parent shell was torn down left the
 * JSONL truncated while the codex child kept editing files
 * (`fixtures/codex/exec-truncated-sighup.jsonl`). Everything therefore goes
 * into its own process group and cancellation kills the group, not the leader.
 */
import { execa, type ResultPromise } from "execa";
import type { CodexLogger } from "./options.js";

export interface SpawnCodexOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Bytes of stderr to retain for diagnostics. */
  stderrTailBytes: number;
}

export interface CodexProcess {
  readonly pid: number | undefined;
  readonly subprocess: ResultPromise;
  /** True once the subprocess promise has settled. */
  exited(): boolean;
  /** Async iterable of decoded stdout chunks. */
  stdout(): AsyncIterable<string>;
  /** Everything seen on stderr, capped at `stderrTailBytes`. */
  stderrTail(): string;
  /** SIGTERM the whole group, then SIGKILL after `graceMs`. */
  kill(graceMs: number, logger: CodexLogger): Promise<void>;
}

/**
 * Kill an entire process group. POSIX only: `process.kill(-pid)` addresses the
 * group whose id equals the leader's pid, which is what `detached: true`
 * (setsid) gives us. Falls back to the single process on Windows or when the
 * group has already gone.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return true;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM / anything else: fall through to the single-process attempt.
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function spawnCodex(options: SpawnCodexOptions): CodexProcess {
  const subprocess = execa(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    // §1.1: with a readable stdin Codex appends a `<stdin>` block to the prompt.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Own process group, so cancel can take the whole tree down.
    detached: process.platform !== "win32",
    buffer: false,
    reject: false,
    encoding: "utf8",
    windowsHide: true,
  });

  let stderrTail = "";
  const stderrStream = subprocess.stderr;
  if (stderrStream) {
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string) => {
      stderrTail += chunk;
      if (stderrTail.length > options.stderrTailBytes) {
        stderrTail = stderrTail.slice(-options.stderrTailBytes);
      }
    });
    stderrStream.on("error", () => {});
  }

  const pid = subprocess.pid;
  let exited = false;
  void subprocess.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );

  return {
    pid,
    subprocess,
    exited: () => exited,
    stdout(): AsyncIterable<string> {
      const stream = subprocess.stdout;
      if (!stream) return emptyIterable();
      stream.setEncoding("utf8");
      return stream as unknown as AsyncIterable<string>;
    },
    stderrTail: () => stderrTail,
    async kill(graceMs: number, logger: CodexLogger): Promise<void> {
      if (pid === undefined) return;
      logger.debug("codex: terminating process group", { pid, graceMs });
      killProcessGroup(pid, "SIGTERM");
      const exited = await Promise.race([
        subprocess.then(
          () => true,
          () => true,
        ),
        delay(graceMs).then(() => false),
      ]);
      if (!exited) {
        logger.warn("codex: process group survived SIGTERM, sending SIGKILL", { pid });
        killProcessGroup(pid, "SIGKILL");
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function* emptyIterable(): AsyncIterable<string> {
  // no output
}
