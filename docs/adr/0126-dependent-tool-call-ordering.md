# ADR 0126: Dependent tool-call ordering

- Status: Accepted
- Date: 2026-09-13

## Context

Provider APIs may return several tool calls in one response. Nexestra executes independent calls
concurrently, but the built-in `delegate` tool depends on the in-memory task IDs populated by a
preceding `plan` call. Running both at once can make a valid same-turn batch fail because delegation
observes an empty plan set.

## Decision

When one provider response contains both `plan` and `delegate` calls, Nexestra executes all calls
other than `delegate` concurrently, waits for them to finish, and then executes the dependent
delegations concurrently. Tool outputs are placed back in the provider's original call order.

Responses without this dependency retain the existing concurrent execution behavior.

## Consequences

Same-turn plan/delegate batches have deterministic state visibility while independent reads and
other tools retain parallel latency. A provider still cannot invent task IDs: delegation validation
continues to require IDs returned by the completed `plan` call.
