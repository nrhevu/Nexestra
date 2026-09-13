# Dependent tool-call ordering research — 2026-09-13

Anthropic's current tool-use guidance recommends parallel calls when there are no dependencies and
explicitly says dependent calls should run sequentially. Its implementation guide also exposes a
`disable_parallel_tool_use` control for cases where a single tool call is required: [Anthropic tool
use implementation](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use).

Nexestra's provider-neutral runtime already runs independent calls concurrently, which is useful
for repository reads and parallel research. The built-in `delegate` call has a local dependency on
`plan`: the plan hook must finish before its task IDs are accepted. The runtime now keeps parallel
execution for independent calls but places delegations after all plan calls in the same response.
Outputs remain indexed by the provider call order, so OpenAI Chat, Responses, and Anthropic adapters
receive the same shape of tool results.
