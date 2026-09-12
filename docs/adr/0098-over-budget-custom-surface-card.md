# ADR 0098: Add an over-budget custom surface card

Status: Accepted

## Context

Declarative custom surfaces currently show generic navigation and selected-workspace counts. The
harness brief emphasizes price optimization, while run history already computes observed estimates
above configured per-run limits.

## Decision

Add the allowlisted `over_budget` card action. During bootstrap, only when configured, the server
reads the selected workspace's bounded run telemetry summary. It supplies `overBudgetRunCount` only
when transcript coverage is complete, using zero when complete telemetry contains no over-budget
runs. Incomplete coverage omits the count. The card navigates to Run history with the
cursor-independent `cost=over_budget` filter selected. No transcript rows, raw errors, provider
configuration, or credentials enter the custom-surface response.

## Consequences

Domain-specific surfaces can expose a price-review queue without executable configuration or a new
data store. The count is a read-time local signal and can change as runs finish or pricing changes;
it does not enforce spend. Incomplete history remains visible as an absent count rather than a
misleading zero.
