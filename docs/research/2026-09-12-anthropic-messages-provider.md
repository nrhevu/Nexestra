# Research: Anthropic Messages provider

Anthropic's Messages API uses a `POST /v1/messages` endpoint with `x-api-key` and an
`anthropic-version` header. Tool definitions use `name`, `description`, and `input_schema`; a
model's tool calls are `tool_use` content blocks and results are returned in `tool_result` blocks
inside the user/assistant message sequence. Its streaming protocol emits `content_block_delta`
events, with text in `text_delta` and fragmented JSON arguments in `input_json_delta`.

Nexestra now adapts those structures into the existing provider-neutral Master loop. The adapter
keeps the same twelve-step tool bound, runs the existing permission checks, and caps responses at
the existing one MiB transport limit. Partial Anthropic usage events are combined only after the
stream closes, then normalized into optional input/output/total token counts so run history keeps
the existing estimate semantics.

The implementation deliberately leaves provider-specific server tools and extended-thinking
controls unconfigured. Those features would need separate permission, cost and activity models.

Sources: [Messages API](https://docs.anthropic.com/en/api/messages), [tool-use implementation](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use), and [streaming events](https://docs.anthropic.com/en/api/messages-streaming).
