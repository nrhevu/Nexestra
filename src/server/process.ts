import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? safeProcessEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let settled = false;
    let terminalError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      terminate(new Error(`Agent đã quá thời gian chờ ${options.timeoutMs ?? 180_000}ms.`));
    }, options.timeoutMs ?? 180_000);

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes <= maxBytes) stdout += chunk.toString("utf8");
      else terminate(new Error("Agent trả về quá nhiều dữ liệu."));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes <= maxBytes) stderr += chunk.toString("utf8");
      else terminate(new Error("Agent trả về quá nhiều dữ liệu."));
    });
    child.on("error", (error) => finish(error));
    child.on("close", (exitCode) => {
      if (terminalError) finish(terminalError);
      else finish(undefined, { stdout, stderr, exitCode: exitCode ?? 1 });
    });

    function terminate(error: Error) {
      if (terminalError || settled) return;
      terminalError = error;
      stopProcess(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        stopProcess(child.pid, "SIGKILL");
      }, options.terminationGraceMs ?? 2_000);
      killTimer.unref();
    }

    function finish(error?: Error, result?: CommandResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (error) reject(error);
      else if (result) resolvePromise(result);
    }
  });
}

export function safeProcessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "CODEX_HOME",
    "OPENCODE_CONFIG",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return undefined;
}

export function stopProcess(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may already have exited.
  }
}
