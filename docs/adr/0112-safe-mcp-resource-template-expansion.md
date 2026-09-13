# ADR 0112: Expand MCP resource templates deterministically

- Status: Accepted
- Date: 2026-09-13

## Context

MCP resource templates are executable read capabilities. Treating a missing variable as an empty
string or silently dropping extra variables can send a request to a different URI than the model
intended. Variable values can also carry control characters or excessive data.

## Decision

The template tool may read only an exact URI template returned by the server catalog. Expansion
parses every `{name}` placeholder, requires each declared value, rejects undeclared values, limits
the variable map to 50 entries and each scalar value to 2,000 characters, rejects control
characters, and applies `encodeURIComponent` before substitution. Non-scalar values and malformed
templates are rejected. Existing catalog and response-size limits remain in force.

## Consequences

- Missing, extra, malformed, or unsafe variables fail before any MCP read occurs.
- Delimiters such as `/`, `?`, and `#` in values become data rather than URI structure.
- This supports simple cataloged placeholders; broad RFC 6570 expansion remains out of scope.
