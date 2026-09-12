# ADR 0053 — Agent pricing profiles

## Status

Accepted.

## Context

Run history records provider-reported tokens, but token totals alone do not compare spend when a
workspace uses agents with different models or gateways. Hardcoded provider prices would become
stale and would be wrong for private or discounted endpoints.

## Decision

Agents may store an optional local pricing profile with input, output, and cached-input USD rates per
million tokens. The Agent dialog exposes these rates; API clients may set or clear them. No
credentials or provider payloads are involved.

When both input and output rates are present, run-history per-agent metrics include an estimated USD
cost. Cached input uses its explicit rate when configured, otherwise the normal input rate. Estimates
are derived from the latest configured profile and are intentionally labeled estimates; historical
runs are not rewritten when a profile changes. Aggregate token and duration metrics remain available
when no profile is configured.

## Limits

Prices are user-supplied and may differ from an invoice because gateways use different accounting,
rounding, or discounts. Quality scores, currency conversion, and automatic model selection remain
separate decisions.
