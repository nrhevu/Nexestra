# ADR 0088 — Bounded MCP resource reads

## Status

Accepted.

## Decision

Connected MCP servers expose a `read_mcp_resource` tool when resources are cataloged. URIs must be
listed by that server, are capped at 500 entries, and returned text is limited to the existing 5 MiB
MCP response budget. Unknown URIs are rejected.
