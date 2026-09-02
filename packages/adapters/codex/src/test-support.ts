/**
 * Test-only helpers: locate and load the recordings in `fixtures/codex/`.
 *
 * Kept out of `index.ts` so nothing in the runtime surface depends on the
 * repository layout.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CodexFixtureMeta {
  harness: string;
  harnessVersion: string;
  scenario: string;
  argv: string[];
  cwd: string;
  exitCode: number | null;
  stderr?: string;
  outputSchema?: Record<string, unknown>;
  notes?: string;
}

export interface CodexFixture {
  name: string;
  /** Raw JSONL, exactly as Codex wrote it. */
  jsonl: string;
  meta: CodexFixtureMeta;
}

/** Walk up from this file until the repository's `fixtures/codex` shows up. */
export function fixturesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(dir, "fixtures", "codex");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate fixtures/codex from @nexestra/adapter-codex");
}

export function loadFixture(name: string): CodexFixture {
  const dir = fixturesDir();
  const jsonl = readFileSync(path.join(dir, `${name}.jsonl`), "utf8");
  const meta = JSON.parse(
    readFileSync(path.join(dir, `${name}.meta.json`), "utf8"),
  ) as CodexFixtureMeta;
  return { name, jsonl, meta };
}

/** Every `fixtures/codex/*.jsonl` recording, in a stable order. */
export const CODEX_FIXTURE_NAMES = [
  "exec-cancelled-sigint",
  "exec-edit-test",
  "exec-output-schema",
  "exec-read-only-question",
  "exec-review-uncommitted",
  "exec-truncated-sighup",
] as const;

export type CodexFixtureName = (typeof CODEX_FIXTURE_NAMES)[number];

/**
 * A stand-in for the `codex` binary: a POSIX shell script that records its
 * argv / cwd / stdin, replays a fixture on stdout and then behaves according
 * to `FAKE_MODE`.
 *
 * Using a real script (rather than a mocked `execa`) is deliberate — it is the
 * only way to exercise `detached: true`, the process-group kill and the
 * "child outlives the parent" case from `exec-truncated-sighup`.
 */
export const FAKE_CODEX_SCRIPT = `#!/bin/sh
set -u
LOG="\${FAKE_LOG:-/dev/null}"
: > "$LOG"
printf 'argv:%s\\n' "$*" >> "$LOG"
printf 'cwd:%s\\n' "$(pwd)" >> "$LOG"
if IFS= read -r stdin_line; then
  printf 'stdin:%s\\n' "$stdin_line" >> "$LOG"
else
  printf 'stdin:closed\\n' >> "$LOG"
fi

# Interrogation subcommands used by discover().
if [ "\${1:-}" = "--version" ] || [ "\${1:-}" = "-V" ]; then
  printf 'codex-cli %s\\n' "\${FAKE_VERSION:-0.148.0}"
  exit "\${FAKE_VERSION_EXIT:-0}"
fi
if [ "\${1:-}" = "login" ]; then
  printf '%s\\n' "\${FAKE_LOGIN:-Logged in using ChatGPT}"
  exit "\${FAKE_LOGIN_EXIT:-0}"
fi

LAST=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then LAST="\${2:-}"; fi
  shift
done

case "\${FAKE_MODE:-success}" in
  success)
    cat "$FAKE_STREAM_FILE"
    if [ -n "$LAST" ]; then printf '%s' "\${FAKE_LAST_MESSAGE:-done}" > "$LAST"; fi
    exit 0
    ;;
  no-last-message)
    cat "$FAKE_STREAM_FILE"
    exit 0
    ;;
  argerror)
    printf "error: unexpected argument '--nope' found\\n" >&2
    exit 2
    ;;
  failure)
    head -n 2 "$FAKE_STREAM_FILE"
    printf 'Reading additional input from stdin...\\n' >&2
    printf 'stream error: connection reset by peer\\n' >&2
    exit 1
    ;;
  hang)
    sh -c 'sleep 120' &
    printf '%s' "$!" > "\${FAKE_CHILD_PID_FILE:-/dev/null}"
    head -n 2 "$FAKE_STREAM_FILE"
    sleep 120
    exit 0
    ;;
esac
`;

/** Split `text` into `size`-byte chunks, to exercise partial-line handling. */
export function chunked(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}
