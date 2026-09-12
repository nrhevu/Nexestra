# Per-run cost visibility — research and QA, 12 September 2026

The product brief asks Nexestra to compare heterogeneous harnesses by capability and price. Existing
run history already aggregated estimated cost by agent, but a user comparing retries or selecting a
single task for an evaluation could not see that task's cost in the list or exported row.

The bounded slice adds `estimatedCostUsd` to each redacted `RunHistoryItem` when provider usage and
the agent's input/output pricing are both available. It is derived during reads, shown beside the
row's token count, and included automatically in the existing versioned run-history export. Missing
telemetry or incomplete pricing remains an explicit omission rather than a guessed zero.

Validation uses the provider-free Vitest fixtures: contract tests reject negative and non-finite
values, the store test proves cached-input pricing is reflected in the row, and the browser test
checks the visible formatted estimate. No credentials or live providers are needed.

This does not estimate invoice totals, account for provider-specific discounts, or preserve a price
snapshot across profile edits. Those require an explicit billing policy and are outside this slice.
