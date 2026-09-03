# 0007 — Replace per-tool profile permissions with three access modes

## Context

Master creation exposed a separate Allow, Ask, or Deny control for every tool category. The matrix
made the primary safety choice difficult to understand and diverged from the simpler interaction
model expected by users of agent harnesses. OpenCode also distinguishes normal permission prompts
from an auto-approve mode, while still enforcing explicit deny rules.

## Decision

Store one `accessMode` on every Master profile:

- `ask` allows read, skill, todo, and question tools directly, while edit, shell, web, custom, and
  MCP tools require approval;
- `auto` allows every built-in tool directly, while custom and MCP tools require approval;
- `full` allows every tool directly.

Workspace rules in `nexestra.config.json` remain an advanced policy layer and can only make the
selected mode stricter. The fixed credential exclusions, repository path checks, private-network
fetch protection, output caps, timeouts, and secret redaction cannot be disabled by any mode.

For ChatGPT OAuth Masters, `ask` maps to Codex read-only, `auto` maps to the workspace-write sandbox
with automatic approval review, and `full` uses Codex's explicit approval-and-sandbox bypass. The
creation form presents the same three choices for both ChatGPT and custom providers.

Migrate state from version 4 to version 5. A previous profile with every current permission set to
Allow becomes Full access; a profile with both edit and shell set to Allow becomes Auto; all other
profiles become Ask for permission. The old matrix is removed from persisted and API agent shapes.

## Consequences

The common case requires one decision and agent cards can display a short, stable access label.
Users who need hard per-tool restrictions can keep them in workspace configuration rather than
duplicating them across agent profiles. Full access is intentionally conspicuous because it trusts
the provider and any installed extensions with the current local user's authority.

## Status

Accepted for Milestone M9.
