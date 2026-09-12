# ADR 0059 — Show safe failure kinds in Run history

## Status

Accepted.

## Context

Run history is the place to decide whether a failed attempt should be retried, but raw run errors
may contain provider payloads, command output, paths, or credentials. The history API previously
omitted errors entirely, forcing a navigation to the conversation for every failure.

## Decision

The durable run-history projection classifies an error into one of six bounded kinds: timeout,
aborted, verification, unavailable, provider, or unknown. The history response carries only that
kind; it never carries the original error string. The row explains that details are available in
the conversation. Full thread views continue using their existing redaction and bounds.

## Consequences

Users can distinguish common recovery paths while monitoring and retrying runs without expanding
the history API's secret exposure. Classification is intentionally conservative and may return
unknown for provider-specific wording. Exact error text remains available by opening the canonical
conversation, and output search remains separate work.
