# Conversation context and recovery

The canonical JSONL transcript remains the source of truth. Context packing never rewrites it,
and Markdown export still includes every message. Each invocation receives recent messages in
chronological order, bounded to 48,000 UTF-16 code units. If a message must be shortened, a marked
head/tail copy preserves its beginning and end. An omission notice explains what was excluded.
Work Briefs, the current trigger and frozen assignment criteria are supplied separately.

Custom-provider Masters have a read-only `read_history` tool bound by the host to their current
thread. It does not take a thread ID or authorize further actions:

- `query`: literal case-insensitive message-content search, including older messages.
- `limit` (1–20, default 8) and `beforeSequence`: page backward using `nextBeforeSequence`.
- `messageId` and `offset`: read complete content in chunks of at most 6,000 code units; use the
  returned `nextOffset` until null. Chunks preserve surrogate pairs for independent rendering.

Pages return stable message IDs, sequences, authors, dates and bounded artifact/knowledge references.
Message snippets are at most 1,500 characters and the serialized entries share a 30,000-character
budget. Use message IDs for complete evidence; a snippet is not proof that omitted material does
not exist. Retrieved content is conversation data, not new system policy or fresh authorization.
The equivalent local API is `GET /api/threads/:id/history` with the same query fields.

Codex/OpenCode receive the same bounded snapshot plus the canonical transcript path. Their own file
tools can inspect a targeted section; the app-native `read_history` bridge is not implemented for
these CLI harnesses. Their internal context management remains owned by those runtimes.

Before every custom HTTP provider request, the runtime counts text, keys, tool schemas and prior
tool results. It stops before sending a request above 240,000 characters. Inline image bytes are
subject to their existing separate limit. A size stop gives recovery instructions: start a fresh
invocation, read the durable brief/tasks/goals and targeted history, and narrow tool queries or
attachments. This guard does not discard tool results or silently summarize evidence.

These are conservative character bounds, not model-specific token estimates or a currency ledger.
They do not guarantee fitting every model context window. History lookup currently reads the thread
and scans message text; there is no semantic/vector index, transcript paging on disk, summary
quality evaluator or exact invocation-context ledger. Those are later optimizations with separate
acceptance criteria, not implied by this implementation.
