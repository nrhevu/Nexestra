/**
 * `opencode serve` lifecycle: one server per workspace directory, started on
 * demand, reused across runs, health-checked, restarted after a crash and
 * killed as a process group.
 *
 * Launch details that were learned the hard way
 * (`docs/harness-protocols.md` §2.1):
 *
 * - `--port 0` picks a free port and the chosen port is printed **only** on
 *   stderr, so `--print-logs` is mandatory and the line has to be parsed.
 * - the server is rooted at its CWD for project detection, hence one per
 *   worktree rather than one global server plus `?directory=`.
 * - `--pure` skips ~45 external plugins whose `plugin.added` events would
 *   otherwise be 13 % of the event stream.
 * - shutdown is `POST /instance/dispose` *and then* a signal: the server spawns
 *   the model's shell commands, so the whole group has to go.
 */
import { killProcessGroup } from "@nexestra/adapter-codex";
import { execa, type ResultPromise } from "execa";
import { OpenCodeClient } from "./client.js";
import { OpenCodeServerError } from "./errors.js";
import { OpenCodeEventStream } from "./events.js";
import type { OpenCodeLogger, ResolvedOpenCodeOptions } from "./options.js";
import type { OpenCodeHealth } from "./types.js";

/** `opencode server listening on http://127.0.0.1:4791` */
const LISTENING_PATTERNS: readonly RegExp[] = [
  /listening on\s+(https?:\/\/\S+)/i,
  /(https?:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d+)/,
  /(https?:\/\/\[[0-9a-f:]+\]:\d+)/i,
];

export interface OpenCodeServerHandle {
  /** Absolute, real path of the workspace this server is rooted at. */
  readonly directory: string;
  readonly url: string;
  readonly client: OpenCodeClient;
  readonly events: OpenCodeEventStream;
  /** `undefined` when attached to an externally managed server. */
  readonly pid: number | undefined;
  /** True when the adapter did not spawn it (`options.attachUrl`). */
  readonly external: boolean;
  /** Version reported by `GET /global/health` at startup. */
  readonly version: string | undefined;
  /** False once the process has exited. */
  alive(): boolean;
  /** Resolves with the exit description when the process dies. */
  onExit(listener: (reason: string) => void): () => void;
  health(timeoutMs?: number): Promise<OpenCodeHealth>;
  dispose(): Promise<void>;
}

interface ServerRecord extends OpenCodeServerHandle {
  subprocess?: ResultPromise;
  exited: boolean;
  exitReason?: string;
  logTail(): string;
}

export interface OpenCodeServerManagerOptions {
  /** Resolves the `opencode` binary lazily, so `attachUrl` never needs one. */
  binary: () => Promise<string>;
  options: ResolvedOpenCodeOptions;
}

export class OpenCodeServerManager {
  readonly #binary: () => Promise<string>;
  readonly #options: ResolvedOpenCodeOptions;
  readonly #logger: OpenCodeLogger;
  readonly #servers = new Map<string, ServerRecord>();
  readonly #starting = new Map<string, Promise<ServerRecord>>();
  #disposed = false;

  constructor(options: OpenCodeServerManagerOptions) {
    this.#binary = options.binary;
    this.#options = options.options;
    this.#logger = options.options.logger;
  }

  /** Live servers, keyed by workspace directory. */
  get servers(): ReadonlyMap<string, OpenCodeServerHandle> {
    return this.#servers;
  }

  /**
   * Return the server for `directory`, starting it if necessary.
   *
   * A cached server that has died, or that no longer answers `/global/health`,
   * is disposed and replaced.
   */
  async ensure(directory: string): Promise<OpenCodeServerHandle> {
    if (this.#disposed) throw new OpenCodeServerError("the server manager has been disposed");
    const key = directory;

    const existing = this.#servers.get(key);
    if (existing) {
      if (existing.alive()) {
        try {
          await existing.health(5000);
          return existing;
        } catch (error) {
          this.#logger.warn("opencode: server failed its health check, restarting", {
            directory,
            error: describe(error),
          });
        }
      } else {
        this.#logger.warn("opencode: server process is gone, restarting", {
          directory,
          reason: existing.exitReason,
        });
      }
      this.#servers.delete(key);
      await existing.dispose().catch(() => {});
    }

    const inFlight = this.#starting.get(key);
    if (inFlight) return inFlight;

    const promise = this.#start(directory).finally(() => this.#starting.delete(key));
    this.#starting.set(key, promise);
    const server = await promise;
    this.#servers.set(key, server);
    return server;
  }

  /** The server for `directory`, without starting one. */
  get(directory: string): OpenCodeServerHandle | undefined {
    return this.#servers.get(directory);
  }

  async dispose(directory: string): Promise<void> {
    const server = this.#servers.get(directory);
    if (!server) return;
    this.#servers.delete(directory);
    await server.dispose();
  }

  async disposeAll(): Promise<void> {
    this.#disposed = true;
    const servers = [...this.#servers.values()];
    this.#servers.clear();
    await Promise.all(servers.map((server) => server.dispose().catch(() => {})));
  }

  // ------------------------------------------------------------------ private

  async #start(directory: string): Promise<ServerRecord> {
    if (this.#options.attachUrl) return this.#attach(directory, this.#options.attachUrl);

    const binary = await this.#binary();
    const args = [
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
      "--print-logs",
      "--log-level",
      this.#options.logLevel,
      ...(this.#options.pure ? ["--pure"] : []),
      ...this.#options.extraServeArgs,
    ];

    const subprocess = execa(binary, args, {
      cwd: directory,
      env: { ...process.env, ...this.#options.env } as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Own process group: the server spawns the model's shell commands, and a
      // plain kill would orphan them (the Codex recording showed exactly that).
      detached: process.platform !== "win32",
      buffer: false,
      reject: false,
      encoding: "utf8",
      windowsHide: true,
    });

    let tail = "";
    let url: string | undefined;
    let onUrl: ((value: string) => void) | undefined;
    const urlFound = new Promise<string>((resolve) => {
      onUrl = resolve;
    });
    const consume = (chunk: string) => {
      tail = `${tail}${chunk}`.slice(-8192);
      if (url) return;
      const found = parseServerUrl(chunk);
      if (found) {
        url = found;
        onUrl?.(found);
      }
    };
    for (const stream of [subprocess.stdout, subprocess.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => consume(chunk));
      stream.on("error", () => {});
    }

    const exitListeners = new Set<(reason: string) => void>();
    const record: ServerRecord = {
      directory,
      url: "",
      client: undefined as unknown as OpenCodeClient,
      events: undefined as unknown as OpenCodeEventStream,
      pid: subprocess.pid,
      external: false,
      version: undefined,
      exited: false,
      subprocess,
      alive: () => !record.exited,
      logTail: () => tail,
      onExit(listener) {
        if (record.exited) {
          listener(record.exitReason ?? "exited");
          return () => {};
        }
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      health: (timeoutMs?: number) => record.client.health(timeoutMs ?? 5000),
      dispose: () => this.#disposeRecord(record),
    };

    void subprocess.then(
      (result) => markExit(record, exitListeners, `exit code ${result.exitCode ?? 0}`),
      (error) => markExit(record, exitListeners, describe(error)),
    );

    const found = await Promise.race([
      urlFound,
      subprocess.then(() => undefined),
      sleep(this.#options.startTimeoutMs).then(() => undefined),
    ]);

    if (!found) {
      await this.#disposeRecord(record).catch(() => {});
      throw new OpenCodeServerError(
        `opencode serve did not report a listening URL within ${this.#options.startTimeoutMs}ms` +
          `${tail.trim() ? `: ${lastLines(tail, 5)}` : ""}`,
      );
    }

    const mutable = record as { url: string; client: OpenCodeClient; events: OpenCodeEventStream };
    mutable.url = found;
    mutable.client = new OpenCodeClient({
      baseUrl: found,
      directory,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      fetch: this.#options.fetch,
    });
    mutable.events = new OpenCodeEventStream({
      client: mutable.client,
      logger: this.#logger,
      delayMs: this.#options.reconnectDelayMs,
      maxDelayMs: this.#options.reconnectMaxDelayMs,
    });

    const health = await this.#waitForHealth(record);
    (record as { version: string | undefined }).version = health.version;
    this.#logger.debug("opencode: server ready", {
      directory,
      url: found,
      pid: record.pid,
      version: health.version,
    });
    return record;
  }

  async #attach(directory: string, url: string): Promise<ServerRecord> {
    const client = new OpenCodeClient({
      baseUrl: url,
      directory,
      requestTimeoutMs: this.#options.requestTimeoutMs,
      fetch: this.#options.fetch,
    });
    const events = new OpenCodeEventStream({
      client,
      logger: this.#logger,
      delayMs: this.#options.reconnectDelayMs,
      maxDelayMs: this.#options.reconnectMaxDelayMs,
    });
    const record: ServerRecord = {
      directory,
      url,
      client,
      events,
      pid: undefined,
      external: true,
      version: undefined,
      exited: false,
      alive: () => true,
      logTail: () => "",
      onExit: () => () => {},
      health: (timeoutMs?: number) => client.health(timeoutMs ?? 5000),
      dispose: async () => {
        // Never dispose a server we did not start.
        await events.close();
      },
    };
    const health = await this.#waitForHealth(record);
    (record as { version: string | undefined }).version = health.version;
    return record;
  }

  async #waitForHealth(record: ServerRecord): Promise<OpenCodeHealth> {
    const deadline = Date.now() + this.#options.startTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (record.exited) break;
      try {
        return await record.client.health(2000);
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    await this.#disposeRecord(record).catch(() => {});
    throw new OpenCodeServerError(
      `opencode server at ${record.url} never became healthy${
        record.exitReason ? ` (process ${record.exitReason})` : ""
      }`,
      lastError,
    );
  }

  async #disposeRecord(record: ServerRecord): Promise<void> {
    await record.events?.close().catch(() => {});
    if (record.external) return;
    if (!record.exited && record.client) {
      // Graceful first: lets the server flush its state before the signal.
      await record.client.dispose(3000).catch(() => {});
    }
    const pid = record.pid;
    if (pid === undefined || record.exited) return;
    this.#logger.debug("opencode: terminating server process group", { pid });
    killProcessGroup(pid, "SIGTERM");
    const exited = await Promise.race([
      record.subprocess?.then(
        () => true,
        () => true,
      ) ?? Promise.resolve(true),
      sleep(this.#options.killGraceMs).then(() => false),
    ]);
    if (!exited) {
      this.#logger.warn("opencode: server survived SIGTERM, sending SIGKILL", { pid });
      killProcessGroup(pid, "SIGKILL");
    }
  }
}

function markExit(
  record: ServerRecord,
  listeners: Set<(reason: string) => void>,
  reason: string,
): void {
  if (record.exited) return;
  record.exited = true;
  record.exitReason = reason;
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch {
      // A crash listener must not break the teardown path.
    }
  }
  listeners.clear();
}

/** Extract `http://127.0.0.1:<port>` from a server log chunk. */
export function parseServerUrl(text: string): string | undefined {
  for (const pattern of LISTENING_PATTERNS) {
    const match = pattern.exec(text);
    const found = match?.[1];
    if (found) return found.replace(/[.,)\]]+$/, "").replace(/\/$/, "");
  }
  return undefined;
}

function lastLines(text: string, count: number): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join(" | ");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
