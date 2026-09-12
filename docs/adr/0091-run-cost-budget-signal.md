# ADR 0091 — Post-run cost budget signal

## Status

Accepted.

## Decision

Agent pricing profiles may include an optional maximum estimated cost per run. Run history compares
the locally derived estimate with that limit after usage is available, exposes the limit and an
over-budget flag on the row, and reports a filtered over-budget count in the summary.

The signal is observational. It does not block dispatch, stop a provider, or claim invoice accuracy;
missing usage or incomplete pricing leaves the estimate and comparison unavailable. Existing pricing
and redaction boundaries remain unchanged.
