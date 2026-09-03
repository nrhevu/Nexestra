# 0011 — Live agent activity streams

## Context

Active threads refreshed their complete projection once per second. Users saw a generic working
indicator until the next request, custom-provider answers appeared only after completion, and
native Codex or OpenCode tool events were discarded with the child-process output. This hid the
observable work that an agent harness normally presents and caused repeated transcript reads.

The event references are the official OpenCode `run --format json` implementation at commit
[`b578b726`](https://github.com/anomalyco/opencode/blob/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d/packages/opencode/src/cli/cmd/run.ts)
and Codex's official [`exec_events.rs`](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs).

The canonical thread JSONL must remain append-only and useful as agent context. Persisting each
token as a message would duplicate partial answers, grow transcripts quickly, and expose
half-formed Markdown after restart.

## Decision

Keep one process-local activity projection per live run. It contains the current public phase and
the accumulated user-facing answer. Reasoning visibility is amended by ADR 0012. Publish snapshots
over a thread-scoped Server-Sent Events endpoint. Each event carries a monotonic process-local
revision and a refresh flag; response-only changes update React directly, while run, message, and
tool changes reload the durable thread projection. Fall back to active-thread polling only when
EventSource is unavailable.

Request SSE from both supported custom-provider protocols. Incrementally parse Chat Completions
content and fragmented tool calls, plus Responses text deltas, function-call arguments, and the
completed response. Preserve JSON responses for compatible endpoints that ignore streaming.
Continue enforcing the one-megabyte response limit while reading the stream.

Read Codex and OpenCode JSONL stdout as it arrives and preserve partial lines between process
chunks. Convert their native tool records to Nexestra `tool.updated` events with bounded, redacted
input and summaries. OpenCode runs with `--thinking` so lifecycle reasoning events are observable.
ADR 0012 permits their transient display without copying reasoning content into the shared chat.

Persist completed tool state and exactly one final agent message. Remove the live response after
the final message and run status are durable. Activity snapshots never become transcript messages.

## Consequences

The active thread shows tool calls and answer text as soon as each runtime exposes them, with no
one-second delay and no repeated full-thread request for token-only updates. Refresh events still
use the existing thread projection, keeping transcript recovery and approval flows unchanged.

Custom providers offer token-level text. Current Codex and OpenCode non-interactive JSON modes emit
lifecycle and completed content parts rather than every answer token, so Nexestra streams at their
available event granularity. A server restart removes transient activity; existing recovery marks
unfinished durable runs and tools interrupted as before.

## Status

Accepted for Milestone M9.
