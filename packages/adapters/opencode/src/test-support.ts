/**
 * Test-only helpers: the recordings in `fixtures/opencode/`, a fake OpenCode
 * HTTP+SSE server and a fake `opencode` binary.
 *
 * Kept out of `index.ts` so nothing in the runtime surface depends on the
 * repository layout.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSseJson } from "./sse.js";
import { isRecord, type OpenCodeEvent } from "./types.js";

/** Walk up from this file until the repository's `fixtures/opencode` shows up. */
export function fixturesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(dir, "fixtures", "opencode");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate fixtures/opencode from @nexestra/adapter-opencode");
}

export function readFixture(file: string): string {
  return readFileSync(path.join(fixturesDir(), file), "utf8");
}

export function readJsonFixture<T>(file: string): T {
  return JSON.parse(readFixture(file)) as T;
}

/** Every `.sse` recording, with the session the interesting half belongs to. */
export const OPENCODE_SSE_FIXTURES = {
  "edit-test.event-v1": {
    file: "edit-test.event-v1.sse",
    /** The successful `openai/gpt-5.4-mini` edit+test run. */
    sessionId: "ses_fa0608c13ffeUnvTsvg1Cm9goe",
  },
  "edit-test.event-v2": {
    file: "edit-test.event-v2.sse",
    /** `/api/event` never carried the per-part events; kept as a negative fixture. */
    sessionId: "ses_fa0608c13ffeUnvTsvg1Cm9goe",
  },
  "permission.event-v1": {
    file: "permission.event-v1.sse",
    sessionId: "ses_fa05d3da7ffewu9kn1BHjXTrv6",
  },
  "abort.event-v1": {
    file: "abort.event-v1.sse",
    sessionId: "ses_fa05c8cebffeFwTsZBkYJee3BN",
  },
} as const;

export type OpenCodeSseFixtureName = keyof typeof OPENCODE_SSE_FIXTURES;

/** The failed `9router/…` run inside `edit-test.event-v1.sse` (§4.5). */
export const API_ERROR_SESSION_ID = "ses_fa061f5b8ffeclW2NwNUPwjMK1";

/** Parse a recorded stream into events, in order. */
export function loadSseEvents(name: OpenCodeSseFixtureName): OpenCodeEvent[] {
  const text = readFixture(OPENCODE_SSE_FIXTURES[name].file);
  const events: OpenCodeEvent[] = [];
  for (const value of parseSseJson(text)) {
    if (!isRecord(value) || typeof value.type !== "string") continue;
    events.push({
      type: value.type,
      properties: isRecord(value.properties) ? value.properties : {},
      ...(typeof value.id === "string" ? { id: value.id } : {}),
    });
  }
  return events;
}

/** `properties.sessionID`, wherever the variant keeps it (mirrors `events.ts`). */
function sessionOf(event: OpenCodeEvent): string | undefined {
  const properties = event.properties;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  if (isRecord(info) && typeof info.sessionID === "string") return info.sessionID;
  const part = properties.part;
  if (isRecord(part) && typeof part.sessionID === "string") return part.sessionID;
  return undefined;
}

/** Events belonging to `sessionId`, plus the session-less ones when asked. */
export function eventsForSession(
  events: readonly OpenCodeEvent[],
  sessionId: string,
  includeSessionless = false,
): OpenCodeEvent[] {
  return events.filter((event) => {
    const session = sessionOf(event);
    if (session === undefined) return includeSessionless;
    return session === sessionId;
  });
}

// --------------------------------------------------------------- fake server

export interface FakeOpenCodeServerOptions {
  version?: string;
  /** `GET /provider` payload. */
  providers?: unknown;
  /** `GET /agent` payload. */
  agents?: unknown;
  /** `GET /session/{id}/message` payload. */
  messages?: unknown;
  /** Replayed on `POST /session/{id}/prompt_async`. */
  script?: { events: readonly OpenCodeEvent[]; sourceSessionId: string; delayMs?: number };
  /** Fail `POST /session/{id}/prompt_async` with this status. */
  promptStatus?: number;
}

export interface FakeRequestLog {
  method: string;
  url: string;
  body: string;
}

/**
 * An in-process OpenCode server: enough of the v1 surface to drive the adapter
 * end to end over real HTTP and a real `text/event-stream`.
 */
export class FakeOpenCodeServer {
  readonly requests: FakeRequestLog[] = [];
  #server: Server | undefined;
  #url = "";
  #streams = new Set<ServerResponse>();
  #sessions = new Map<string, Record<string, unknown>>();
  #counter = 0;
  #options: FakeOpenCodeServerOptions;
  /** Resolved once a client has subscribed to `GET /event`. */
  #subscribed: (() => void) | undefined;
  readonly subscribed: Promise<void>;

  constructor(options: FakeOpenCodeServerOptions = {}) {
    this.#options = options;
    this.subscribed = new Promise((resolve) => {
      this.#subscribed = resolve;
    });
  }

  get url(): string {
    return this.#url;
  }

  get openStreams(): number {
    return this.#streams.size;
  }

  configure(options: Partial<FakeOpenCodeServerOptions>): void {
    this.#options = { ...this.#options, ...options };
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    this.#url = `http://127.0.0.1:${address.port}`;
    return this.#url;
  }

  async stop(): Promise<void> {
    for (const stream of this.#streams) stream.end();
    this.#streams.clear();
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Push one event onto every open stream. */
  emit(event: OpenCodeEvent | Record<string, unknown>): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.#streams) stream.write(payload);
  }

  /** Replay a recorded session, rewriting its session id onto `sessionId`. */
  async replay(
    events: readonly OpenCodeEvent[],
    sourceSessionId: string,
    sessionId: string,
    delayMs = 0,
  ): Promise<void> {
    for (const event of events) {
      const rewritten = JSON.parse(
        JSON.stringify(event).split(sourceSessionId).join(sessionId),
      ) as OpenCodeEvent;
      this.emit(rewritten);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // ------------------------------------------------------------------ private

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname;
    const body = await readBody(request);
    this.requests.push({ method: request.method ?? "GET", url: request.url ?? "", body });

    if (route === "/event") return this.#stream(response);
    if (route === "/global/health") {
      return json(response, 200, { healthy: true, version: this.#options.version ?? "1.18.25" });
    }
    if (route === "/instance/dispose") return json(response, 200, true);
    if (route === "/provider") {
      return json(
        response,
        200,
        this.#options.providers ?? { all: [], default: {}, connected: [] },
      );
    }
    if (route === "/agent") return json(response, 200, this.#options.agents ?? []);
    if (route === "/session/status") {
      return json(
        response,
        200,
        [...this.#sessions.keys()].map((id) => ({ sessionID: id, status: { type: "idle" } })),
      );
    }
    if (route === "/session" && request.method === "POST") {
      this.#counter += 1;
      const id = `ses_fake${this.#counter}`;
      const created = { ...(JSON.parse(body || "{}") as Record<string, unknown>), id };
      this.#sessions.set(id, created);
      return json(response, 200, created);
    }

    const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(route);
    if (prompt && request.method === "POST") {
      const sessionId = decodeURIComponent(prompt[1] ?? "");
      if (this.#options.promptStatus && this.#options.promptStatus >= 400) {
        return json(response, this.#options.promptStatus, { message: "prompt rejected" });
      }
      response.writeHead(204).end();
      const script = this.#options.script;
      if (script) {
        void this.replay(script.events, script.sourceSessionId, sessionId, script.delayMs ?? 0);
      }
      return;
    }

    const abort = /^\/session\/([^/]+)\/abort$/.exec(route);
    if (abort && request.method === "POST") return json(response, 200, true);

    const messages = /^\/session\/([^/]+)\/message$/.exec(route);
    if (messages && request.method === "GET") {
      return json(response, 200, this.#options.messages ?? []);
    }

    if (/^\/session\/[^/]+\/permissions\/[^/]+$/.test(route)) return json(response, 200, true);
    if (/^\/permission\/[^/]+\/reply$/.test(route)) return json(response, 200, true);
    if (/^\/question\/[^/]+\/(reply|reject)$/.test(route)) return json(response, 200, true);

    json(response, 404, { message: `no fake route for ${route}` });
  }

  #stream(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    this.#streams.add(response);
    response.on("close", () => this.#streams.delete(response));
    this.#subscribed?.();
    this.#subscribed = undefined;
  }
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json" }).end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// --------------------------------------------------------------- fake binary

/**
 * A stand-in for the `opencode` binary: a Node script that answers
 * `--version` / `models` and, for `serve`, starts a real HTTP server, prints
 * the listening line the way OpenCode does and then behaves according to
 * `FAKE_MODE`.
 *
 * Using a real process (rather than a mocked `execa`) is deliberate: it is the
 * only way to exercise the port parsing, `detached: true` and the process-group
 * kill that `OpenCodeServerManager` relies on.
 */
export const FAKE_OPENCODE_SCRIPT = `#!/usr/bin/env node
"use strict";
// CommonJS on purpose: the file is installed without an extension (like the
// real binary), so Node resolves it as CJS whatever the temp dir contains.
const { createServer } = require("node:http");
const { appendFileSync, writeFileSync } = require("node:fs");

const argv = process.argv.slice(2);
const log = process.env.FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(argv) + "\\n");

if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write((process.env.FAKE_VERSION || "1.18.25") + "\\n");
  process.exit(Number(process.env.FAKE_VERSION_EXIT || 0));
}
if (argv[0] === "models") {
  process.stdout.write((process.env.FAKE_MODELS || "openai/gpt-5.4-mini") + "\\n");
  process.exit(0);
}
if (argv[0] !== "serve") {
  process.stderr.write("unknown command\\n");
  process.exit(2);
}

const mode = process.env.FAKE_MODE || "success";
if (mode === "no-listen") {
  setInterval(() => {}, 1000);
} else if (mode === "argerror") {
  process.stderr.write("error: unknown option\\n");
  process.exit(2);
} else {
  const healthy = mode !== "unhealthy";
  const server = createServer((request, response) => {
    if (request.url && request.url.startsWith("/event")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"server.connected","properties":{}}\\n\\n');
      return;
    }
    if (request.url && request.url.startsWith("/global/health")) {
      if (!healthy) {
        response.writeHead(500).end("unhealthy");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: process.env.FAKE_VERSION || "1.18.25" }));
      return;
    }
    if (request.url && request.url.startsWith("/instance/dispose")) {
      response.writeHead(200, { "content-type": "application/json" }).end("true");
      if (process.env.FAKE_EXIT_ON_DISPOSE === "1") setTimeout(() => process.exit(0), 10);
      return;
    }
    response.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    process.stderr.write("opencode server listening on http://127.0.0.1:" + port + "\\n");
    if (process.env.FAKE_CRASH_AFTER_MS) {
      setTimeout(() => process.exit(7), Number(process.env.FAKE_CRASH_AFTER_MS));
    }
  });
  // A child in the same process group, so the group kill can be observed.
  if (process.env.FAKE_CHILD_PID_FILE) {
    const { spawn } = require("node:child_process");
    const child = spawn("sleep", ["120"], { stdio: "ignore" });
    writeFileSync(process.env.FAKE_CHILD_PID_FILE, String(child.pid));
  }
}
`;
