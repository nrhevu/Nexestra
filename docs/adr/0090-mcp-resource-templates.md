# ADR 0090 — Bounded MCP resource templates

## Status

Accepted.

## Decision

Cataloged MCP resource templates expose a bounded read tool. Template URIs must come from the server
catalog; variables are URI-encoded and expanded values use the existing 5 MiB output limit.
