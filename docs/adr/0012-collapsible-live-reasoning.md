# 0012 — Collapsible live reasoning

## Context

ADR 0011 streams phases, tool calls, and response text, but deliberately reduced reasoning records
to a phase label. This makes a long-running harness hard to follow even when Codex, OpenCode, or a
custom provider explicitly emits a user-visible reasoning summary. Keeping those records visible
after completion would also overwhelm the thread and duplicate the final-answer-first reading
experience.

The [OpenAI Responses streaming
contract](https://developers.openai.com/api/reference/resources/responses/streaming-events) defines
`response.reasoning_summary_text.delta` and `response.reasoning_text.delta`. OpenCode emits
completed reasoning parts when run with `--thinking`, and Codex `exec --json` emits reasoning items
at the granularity supported by the CLI. Some compatible Chat Completions providers use
`reasoning_content` or `reasoning` deltas.

## Decision

Add a bounded `thinking` field to the process-local run activity projection and an explicit
activity hook for reasoning. Parse only reasoning text or summaries that the selected runtime
actually emits. Custom Responses requests ask for an automatic summary. Redact known credentials
and cap the accumulated value at 40,000 characters before publishing it over the existing
thread-scoped SSE connection.

Render live reasoning as safe rich Markdown inside a collapsed native `details` disclosure. Keep
tool calls and partial response text visible while the run is active. When a run completes
successfully, remove its transient activity and hide its durable tool cards from the chat timeline;
the final agent message is the only visible result. Failed or interrupted runs retain tool and
error details because no successful final answer exists.

Do not append reasoning to the canonical JSONL transcript. Durable `tool.updated` records remain
available for recovery and audit even though completed tool cards are hidden from the normal chat
timeline.

## Consequences

Users can inspect an active agent's emitted reasoning without losing a concise completed thread.
The disclosure is collapsed by default and inherits the existing Markdown safety boundary. A
server restart still drops reasoning because it is intentionally transient.

This does not reveal reasoning that a model or harness keeps hidden. Event granularity varies by
runtime: custom providers can stream token deltas, while CLI harnesses may publish only completed
reasoning blocks.

## Status

Accepted for Milestone M9.
