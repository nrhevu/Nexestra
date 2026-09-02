/**
 * Typed `fetch` client for the OpenCode **v1** HTTP API.
 *
 * `@opencode-ai/sdk` (1.18.26) is a generated hey-api client that version-drifts
 * independently from the binary (1.18.25 here) and publishes no README; this
 * adapter needs ten endpoints and its own SSE reader anyway, so the request
 * surface is hand-written against the recorded OpenAPI document
 * (`fixtures/opencode/openapi.json`). See `docs/adapters/opencode.md`.
 */
import { OpenCodeHttpError } from "./errors.js";
import { stripTrailingSlash } from "./options.js";
import type {
  OpenCodeAgent,
  OpenCodeHealth,
  OpenCodeMessage,
  OpenCodePermissionReply,
  OpenCodePermissionRequest,
  OpenCodePromptBody,
  OpenCodeProviderList,
  OpenCodeSession,
  OpenCodeSessionCreateBody,
  OpenCodeSessionStatus,
} from "./types.js";

export interface OpenCodeClientOptions {
  baseUrl: string;
  /** Sent as `?directory=` on every session-scoped call. */
  directory?: string;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** `GET /session/status` → one entry per known session. */
export interface OpenCodeSessionStatusEntry {
  sessionID: string;
  status?: OpenCodeSessionStatus;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  readonly directory: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: OpenCodeClientOptions) {
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.directory = options.directory;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /** Absolute URL for `path`, with `?directory=` appended when configured. */
  url(path: string, query: Record<string, string | undefined> = {}): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (this.directory !== undefined) url.searchParams.set("directory", this.directory);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async #request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeoutMs = init.timeoutMs ?? this.#timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(this.url(path), {
        method,
        signal: controller.signal,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new OpenCodeHttpError(method, path, response.status, text);
      }
      // `prompt_async` answers 204 No Content.
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      if (text.length === 0) return undefined as T;
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  // ------------------------------------------------------------------ server

  health(timeoutMs?: number): Promise<OpenCodeHealth> {
    return this.#request<OpenCodeHealth>("GET", "/global/health", undefined, { timeoutMs });
  }

  /** `POST /instance/dispose` — the graceful half of shutting a server down. */
  dispose(timeoutMs?: number): Promise<boolean> {
    return this.#request<boolean>("POST", "/instance/dispose", undefined, { timeoutMs });
  }

  providers(): Promise<OpenCodeProviderList> {
    return this.#request<OpenCodeProviderList>("GET", "/provider");
  }

  agents(): Promise<OpenCodeAgent[]> {
    return this.#request<OpenCodeAgent[]>("GET", "/agent");
  }

  toolIds(): Promise<string[]> {
    return this.#request<string[]>("GET", "/experimental/tool/ids");
  }

  // ----------------------------------------------------------------- session

  createSession(body: OpenCodeSessionCreateBody): Promise<OpenCodeSession> {
    return this.#request<OpenCodeSession>("POST", "/session", body);
  }

  /** Asynchronous prompt: answers **204 No Content**, telemetry comes over SSE. */
  promptAsync(sessionId: string, body: OpenCodePromptBody, signal?: AbortSignal): Promise<void> {
    return this.#request<void>(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/prompt_async`,
      body,
      { signal },
    );
  }

  abort(sessionId: string): Promise<boolean> {
    return this.#request<boolean>("POST", `/session/${encodeURIComponent(sessionId)}/abort`);
  }

  messages(sessionId: string): Promise<OpenCodeMessage[]> {
    return this.#request<OpenCodeMessage[]>(
      "GET",
      `/session/${encodeURIComponent(sessionId)}/message`,
    );
  }

  session(sessionId: string): Promise<OpenCodeSession> {
    return this.#request<OpenCodeSession>("GET", `/session/${encodeURIComponent(sessionId)}`);
  }

  sessionStatus(): Promise<OpenCodeSessionStatusEntry[]> {
    return this.#request<OpenCodeSessionStatusEntry[]>("GET", "/session/status");
  }

  // -------------------------------------------------------------- permission

  pendingPermissions(): Promise<OpenCodePermissionRequest[]> {
    return this.#request<OpenCodePermissionRequest[]>("GET", "/permission");
  }

  /**
   * Answer a permission request.
   *
   * The session-scoped route is the one the recording used; the flat
   * `/permission/{id}/reply` route exists as a fallback for a request whose
   * session we no longer know.
   */
  respondPermission(
    sessionId: string,
    permissionId: string,
    response: OpenCodePermissionReply,
  ): Promise<boolean> {
    return this.#request<boolean>(
      "POST",
      `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      { response },
    );
  }

  replyPermission(
    permissionId: string,
    reply: OpenCodePermissionReply,
    message?: string,
  ): Promise<boolean> {
    return this.#request<boolean>(
      "POST",
      `/permission/${encodeURIComponent(permissionId)}/reply`,
      message === undefined ? { reply } : { reply, message },
    );
  }

  // -------------------------------------------------------------------- SSE

  /** Open the global v1 event stream. The caller owns the returned body. */
  async openEventStream(signal: AbortSignal): Promise<Response> {
    const response = await this.#fetch(this.url("/event"), {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) {
      const text = response.ok ? "no response body" : await response.text().catch(() => "");
      throw new OpenCodeHttpError("GET", "/event", response.status, text);
    }
    return response;
  }
}
