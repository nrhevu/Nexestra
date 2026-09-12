# ADR 0089 — Bounded MCP prompt expansion

## Status

Accepted.

## Decision

Cataloged MCP prompts are exposed through a per-server `get_mcp_prompt` tool. Prompt names are
allowlisted from up to 200 catalog entries, arguments are stringified and bounded by schema, and
expanded output uses the existing 5 MiB response budget.
