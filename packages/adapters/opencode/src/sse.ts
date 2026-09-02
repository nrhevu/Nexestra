/**
 * Minimal `text/event-stream` decoder.
 *
 * `GET /event` is a long-lived stream that must survive reconnects and be
 * tolerant of anything the server invents next, so the framing is done here
 * rather than by a client library (`docs/harness-protocols.md` §2.10).
 *
 * Implements the framing rules of the WHATWG event-stream grammar that the
 * OpenCode server actually uses: `field: value` lines, `\n` / `\r\n` / `\r`
 * line ends, a blank line terminating an event, and `:` comment lines
 * (OpenCode sends `: heartbeat`).
 */

export interface SseFrame {
  /** `event:` field; `message` when the server omits it, as OpenCode does. */
  event: string;
  /** Concatenated `data:` lines, newline separated. */
  data: string;
  /** `id:` field, when present. */
  id?: string;
  /** `retry:` field in milliseconds, when present and numeric. */
  retry?: number;
}

export class SseDecoder {
  #buffer = "";
  #dataLines: string[] = [];
  #event = "";
  #id: string | undefined;
  #retry: number | undefined;

  /** Feed a decoded chunk; returns every complete frame it contained. */
  push(chunk: string): SseFrame[] {
    this.#buffer += chunk;
    const frames: SseFrame[] = [];
    // Keep the trailing partial line in the buffer: a chunk boundary can fall
    // in the middle of a 40 KB `data:` line.
    let index = this.#lineEnd();
    while (index >= 0) {
      const line = this.#buffer.slice(0, index);
      // `#skip` reads the *current* buffer, so it must run before the reassign.
      const next = this.#skip(index);
      this.#buffer = this.#buffer.slice(next);
      const frame = this.#line(line);
      if (frame) frames.push(frame);
      index = this.#lineEnd();
    }
    return frames;
  }

  /**
   * Flush a frame the stream ended without terminating.
   *
   * A cut connection normally loses the partial frame; returning it lets the
   * caller decide, and keeps a fixture that does not end in a blank line
   * behaving like one that does.
   */
  flush(): SseFrame | undefined {
    if (this.#buffer.length > 0) {
      const rest = this.#buffer;
      this.#buffer = "";
      this.#line(rest);
    }
    return this.#emit();
  }

  #lineEnd(): number {
    const lf = this.#buffer.indexOf("\n");
    const cr = this.#buffer.indexOf("\r");
    if (lf < 0) return cr;
    if (cr < 0) return lf;
    return Math.min(lf, cr);
  }

  /** How many characters to drop for the line end at `index` (`\r\n` is one). */
  #skip(index: number): number {
    if (this.#buffer[index] === "\r" && this.#buffer[index + 1] === "\n") return index + 2;
    return index + 1;
  }

  #line(line: string): SseFrame | undefined {
    if (line.length === 0) return this.#emit();
    // `: heartbeat` and friends.
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.#event = value;
        return undefined;
      case "data":
        this.#dataLines.push(value);
        return undefined;
      case "id":
        // The spec ignores an id containing NUL; nothing else is filtered.
        if (!value.includes("\0")) this.#id = value;
        return undefined;
      case "retry": {
        const retry = Number(value);
        if (Number.isInteger(retry) && retry >= 0) this.#retry = retry;
        return undefined;
      }
      default:
        // Unknown field: ignored, per the event-stream grammar.
        return undefined;
    }
  }

  #emit(): SseFrame | undefined {
    if (this.#dataLines.length === 0) {
      this.#event = "";
      return undefined;
    }
    const frame: SseFrame = {
      event: this.#event.length > 0 ? this.#event : "message",
      data: this.#dataLines.join("\n"),
    };
    if (this.#id !== undefined) frame.id = this.#id;
    if (this.#retry !== undefined) frame.retry = this.#retry;
    this.#dataLines = [];
    this.#event = "";
    this.#retry = undefined;
    return frame;
  }
}

/** Parse every `data:` payload of an SSE text as JSON, skipping what will not parse. */
export function parseSseJson(text: string): unknown[] {
  const decoder = new SseDecoder();
  const frames = [...decoder.push(text)];
  const tail = decoder.flush();
  if (tail) frames.push(tail);
  const values: unknown[] = [];
  for (const frame of frames) {
    try {
      values.push(JSON.parse(frame.data) as unknown);
    } catch {
      // A recorded stream can end mid-JSON; drop it exactly as runtime would.
    }
  }
  return values;
}
