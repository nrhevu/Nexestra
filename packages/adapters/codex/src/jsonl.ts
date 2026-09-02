/**
 * Line splitter tolerant of partial chunks.
 *
 * `codex exec --json` writes one JSON object per line, but a stdout chunk can
 * end anywhere — including in the middle of a 40 KB `aggregated_output`. The
 * splitter buffers the tail until the next newline and only surrenders it on
 * `flush()`, which is exactly where a killed / truncated run leaves a half
 * written line (see `fixtures/codex/exec-truncated-sighup.jsonl`).
 */
export class JsonlSplitter {
  #buffer = "";

  /** Split a chunk into complete lines, retaining any trailing partial line. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    if (!this.#buffer.includes("\n")) return [];
    const parts = this.#buffer.split("\n");
    this.#buffer = parts.pop() ?? "";
    return parts.map(stripCr).filter((line) => line.length > 0);
  }

  /** Return whatever is left in the buffer and reset it. */
  flush(): string | undefined {
    const rest = stripCr(this.#buffer);
    this.#buffer = "";
    return rest.length > 0 ? rest : undefined;
  }

  /** Bytes currently buffered — non-zero after a truncated stream. */
  get pending(): string {
    return this.#buffer;
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
