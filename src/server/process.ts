import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

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
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? safeProcessEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let settled = false;
    let terminalError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      terminate(new Error(`Agent timed out after ${options.timeoutMs ?? 180_000}ms.`));
    }, options.timeoutMs ?? 180_000);
    const onAbort = () => terminate(abortReason(options.signal));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => collectOutput("stdout", chunk, stdoutDecoder));
    child.stderr.on("data", (chunk: Buffer) => collectOutput("stderr", chunk, stderrDecoder));
    child.stdout.on("end", () => appendOutput("stdout", stdoutDecoder.end()));
    child.stderr.on("end", () => appendOutput("stderr", stderrDecoder.end()));
    child.on("error", (error) => finish(error));
    child.on("close", (exitCode) => {
      if (terminalError) finish(terminalError);
      else finish(undefined, { stdout, stderr, exitCode: exitCode ?? 1 });
    });

    function collectOutput(stream: "stdout" | "stderr", chunk: Buffer, decoder: StringDecoder) {
      if (settled || terminalError) return;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) terminate(new Error("Agent returned too much data."));
      else appendOutput(stream, decoder.write(chunk));
    }

    function appendOutput(stream: "stdout" | "stderr", text: string) {
      if (settled || terminalError || !text) return;
      if (stream === "stdout") stdout += text;
      else stderr += text;
      try {
        if (stream === "stdout") options.onStdout?.(text);
        else options.onStderr?.(text);
      } catch (error) {
        terminate(error instanceof Error ? error : new Error("Could not process agent output."));
      }
    }

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
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (result) resolvePromise(result);
    }
  });
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Process stopped.");
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
