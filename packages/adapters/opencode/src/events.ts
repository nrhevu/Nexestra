/**
 * One shared `GET /event` subscription per server, demultiplexed by session id.
 *
 * The v1 stream is global: every session on the server (and a pile of
 * session-less noise — `plugin.added`, heartbeats, `file.edited`) arrives on
 * the same connection, so opening one per run would multiply the load and
 * still not isolate anything. `docs/harness-protocols.md` §2.3.
 */
import type { OpenCodeClient } from "./client.js";
import type { OpenCodeLogger } from "./options.js";
import { SseDecoder } from "./sse.js";
import { isRecord, type OpenCodeEvent } from "./types.js";

export type OpenCodeEventListener = (event: OpenCodeEvent) => void;

export type OpenCodeStreamLifecycle =
  | { type: "connected"; attempt: number; reconnect: boolean }
  | { type: "disconnected"; attempt: number; reason: string };

export type OpenCodeLifecycleListener = (lifecycle: OpenCodeStreamLifecycle) => void;

export interface OpenCodeEventStreamOptions {
  client: OpenCodeClient;
  logger: OpenCodeLogger;
  /** First reconnect delay; doubles up to `maxDelayMs`. */
  delayMs: number;
  maxDelayMs: number;
}

/** `properties.sessionID`, wherever this event variant happens to keep it. */
export function eventSessionId(event: OpenCodeEvent): string | undefined {
  const properties = event.properties;
  const direct = properties.sessionID;
  if (typeof direct === "string") return direct;
  const info = properties.info;
  if (isRecord(info) && typeof info.sessionID === "string") return info.sessionID;
  const part = properties.part;
  if (isRecord(part) && typeof part.sessionID === "string") return part.sessionID;
  return undefined;
}

export class OpenCodeEventStream {
  readonly #client: OpenCodeClient;
  readonly #logger: OpenCodeLogger;
  readonly #delayMs: number;
  readonly #maxDelayMs: number;

  readonly #bySession = new Map<string, Set<OpenCodeEventListener>>();
  readonly #sessionless = new Set<OpenCodeEventListener>();
  readonly #lifecycle = new Set<OpenCodeLifecycleListener>();

  #controller: AbortController | undefined;
  #loop: Promise<void> | undefined;
  #closed = false;
  #connected = false;
  #attempts = 0;
  #reconnects = 0;
  #ready: Promise<void> | undefined;
  #resolveReady: (() => void) | undefined;

  constructor(options: OpenCodeEventStreamOptions) {
    this.#client = options.client;
    this.#logger = options.logger;
    this.#delayMs = options.delayMs;
    this.#maxDelayMs = options.maxDelayMs;
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** How many times the connection had to be re-established. */
  get reconnects(): number {
    return this.#reconnects;
  }

  /** Start the connect/reconnect loop. Idempotent. */
  start(): void {
    if (this.#closed || this.#loop) return;
    this.#loop = this.#run();
  }

  /**
   * Resolve once the stream is live.
   *
   * Callers must await this **before** prompting: `prompt_async` returns 204
   * immediately and the whole transcript is on the stream, so a subscription
   * opened afterwards loses the first parts.
   */
  async ready(timeoutMs: number): Promise<void> {
    this.start();
    if (this.#connected) return;
    this.#ready ??= new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`opencode event stream did not connect within ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([this.#ready, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Listen to one session's events. Returns an unsubscribe function. */
  subscribe(sessionId: string, listener: OpenCodeEventListener): () => void {
    let set = this.#bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.#bySession.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      const current = this.#bySession.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.#bySession.delete(sessionId);
    };
  }

  /**
   * Listen to events that carry no session id — `file.edited` is the important
   * one, and it is the only signal of a write that arrives before the tool part
   * completes.
   */
  subscribeSessionless(listener: OpenCodeEventListener): () => void {
    this.#sessionless.add(listener);
    return () => this.#sessionless.delete(listener);
  }

  onLifecycle(listener: OpenCodeLifecycleListener): () => void {
    this.#lifecycle.add(listener);
    return () => this.#lifecycle.delete(listener);
  }

  /** Close the connection and stop reconnecting. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller?.abort();
    this.#connected = false;
    const loop = this.#loop;
    this.#loop = undefined;
    if (loop) await loop.catch(() => {});
  }

  // ------------------------------------------------------------------ private

  async #run(): Promise<void> {
    let delay = this.#delayMs;
    while (!this.#closed) {
      this.#attempts += 1;
      const attempt = this.#attempts;
      const controller = new AbortController();
      this.#controller = controller;
      let reason = "stream ended";
      try {
        const response = await this.#client.openEventStream(controller.signal);
        const reconnect = attempt > 1;
        if (reconnect) this.#reconnects += 1;
        this.#connected = true;
        delay = this.#delayMs;
        this.#resolveReady?.();
        this.#resolveReady = undefined;
        this.#emitLifecycle({ type: "connected", attempt, reconnect });
        await this.#read(response);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        if (this.#closed) break;
        this.#logger.debug("opencode: event stream error", { attempt, reason });
      } finally {
        this.#connected = false;
      }
      if (this.#closed) break;
      this.#emitLifecycle({ type: "disconnected", attempt, reason });
      // Full jitter, so several servers do not reconnect in lockstep.
      const wait = Math.round(Math.random() * delay);
      await sleep(wait);
      delay = Math.min(delay * 2, this.#maxDelayMs);
    }
    this.#connected = false;
  }

  async #read(response: Response): Promise<void> {
    const body = response.body;
    if (!body) throw new Error("event stream has no body");
    const decoder = new SseDecoder();
    const utf8 = new TextDecoder();
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      const text = utf8.decode(chunk, { stream: true });
      for (const frame of decoder.push(text)) this.#frame(frame.data);
    }
    const tail = decoder.flush();
    if (tail) this.#frame(tail.data);
  }

  #frame(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      this.#logger.debug("opencode: skipping non-JSON SSE frame", { bytes: data.length });
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.#logger.debug("opencode: skipping SSE frame without a type");
      return;
    }
    const event: OpenCodeEvent = {
      type: parsed.type,
      properties: isRecord(parsed.properties) ? parsed.properties : {},
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    };
    this.dispatch(event);
  }

  /** Deliver one already-parsed event. Exposed for the contract tests. */
  dispatch(event: OpenCodeEvent): void {
    const sessionId = eventSessionId(event);
    if (sessionId === undefined) {
      for (const listener of [...this.#sessionless]) safely(listener, event, this.#logger);
      return;
    }
    const listeners = this.#bySession.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) safely(listener, event, this.#logger);
  }

  #emitLifecycle(lifecycle: OpenCodeStreamLifecycle): void {
    for (const listener of [...this.#lifecycle]) {
      try {
        listener(lifecycle);
      } catch (error) {
        this.#logger.warn("opencode: event stream lifecycle listener threw", error);
      }
    }
  }
}

function safely(
  listener: OpenCodeEventListener,
  event: OpenCodeEvent,
  logger: OpenCodeLogger,
): void {
  try {
    listener(event);
  } catch (error) {
    logger.warn("opencode: event listener threw", error);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
