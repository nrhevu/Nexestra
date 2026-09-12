# Run-history cost summary — research and QA, 12 September 2026

The harness brief calls for comparing agents by capability and price. Nexestra already derived
local estimated cost for rows and per-agent breakdowns, but the filter-scoped run-history summary
did not provide a total. That made a workspace or status comparison require manual addition and
made the existing export less useful for offline routing analysis.

This bounded slice adds optional `estimatedCostUsd` and `estimatedCostRuns` metrics. The server sums
only runs with provider usage and complete input/output pricing, while the count identifies partial
coverage. The browser displays both values and the existing versioned export carries them through
its typed summary. Missing usage or pricing remains omitted rather than guessed as zero.

The provider-free store, contract, and browser fixtures cover the aggregate value and its visible
coverage. No credentials or live provider calls are needed. This does not create billing invoices,
snapshot historical prices, or model provider-specific discounts.
