# ADR 0071: Support Anthropic Messages as a custom Master provider

## Status

Accepted

## Context

Nexestra's provider-neutral Master loop previously accepted only OpenAI Chat Completions and
Responses payloads. That excluded a major heterogeneous-provider option even though the loop's
tool registry, approval model and redaction boundaries are provider independent.

## Decision

Add `anthropic-messages` as a third custom-provider protocol. Nexestra appends `messages` to the
configured API root, sends the stored credential only as `x-api-key`, and pins the documented
`anthropic-version` header. Requests use a bounded `max_tokens` value, the Anthropic `tools`
shape, and user/assistant content blocks. Streaming `content_block_delta` text and
`input_json_delta` events are assembled into the same internal reply and tool-call shape used by
the existing Master loop. Input and output token usage is normalized when both values are
reported.

Provider-specific request and response details remain in the runtime adapter. Canonical
transcripts continue to contain only redacted tool metadata and the final response; credentials
and raw provider payloads are never persisted.

## Consequences

Anthropic Messages can use built-in, custom and MCP tools, including durable planning and Worker
delegation. Tool results are sent as `tool_result` blocks in a user message, matching Anthropic's
conversation contract. Anthropic's provider-specific features outside this adapter, such as
server-side tools, prompt caching controls and extended thinking, are intentionally not inferred.

See [Anthropic Messages API](https://docs.anthropic.com/en/api/messages) and
[tool-use implementation](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use).
