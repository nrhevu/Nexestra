# 0005 — Provider-neutral Master harness with explicit tool permissions

## Context

Custom Master agents previously sent one prompt to an OpenAI-compatible endpoint and could only
return text. They could not inspect the repository, make a requested change, run verification, or
continue reasoning from a tool result. ChatGPT Masters were also forced into the same read-only
discussion policy as Worker agents. This made “Master” a provider label rather than a useful
harness.

OpenCode demonstrates three useful boundaries for a local coding harness: tools are registered
independently of the model provider, permission checks happen before execution, and the model runs
in a bounded tool/result loop instead of receiving implicit access to the host.

## Decision

Give each Master profile explicit `read`, `edit`, and `bash` permissions. Custom providers may set
each permission to `allow`, `ask`, or `deny`; safe defaults allow reads and ask before edits or shell
commands. `ask` writes a pending tool event to the canonical thread transcript, changes the run to
`waiting_approval`, and resumes only after the local user approves or denies it in the thread.

Expose a provider-neutral registry with `list`, `glob`, `grep`, `read`, `edit`, `write`, and `bash`.
File tools accept repository-relative paths, reject traversal and escaping symlinks, protect the
Nexestra credential file, and cap files, results, and stored metadata. Shell processes close stdin,
use the existing environment allowlist, cap time and output, and never store command output in the
transcript. Known custom-provider credentials are redacted from tool input, output, errors, and run
errors.

Drive both OpenAI Chat Completions and OpenAI Responses through the same registry. Feed each tool
result back using that protocol's native function-call result shape, stop after twelve tool rounds,
and abort after three identical calls to prevent accidental loops. Persist tool status and a small
input/summary record as `tool.updated` events; keep full file and command output only in memory for
the current provider turn.

ChatGPT OAuth remains owned by Codex CLI. A ChatGPT Master therefore selects either read-only or
build access. Build access runs `codex exec` with its `workspace-write` sandbox and automatic
approval review; Nexestra does not read OAuth tokens or attempt to reimplement Codex's native tool
protocol.

## Consequences

Custom Masters can now complete the basic inspect/change/verify loop with either supported OpenAI
protocol, and the user can audit and gate mutations from the thread. State version 2 migrates to
version 3 by adding the safe permission defaults. Startup recovery interrupts both a run waiting
for approval and its unfinished tool call, so it can be retried rather than remaining stuck.

File tools are confined to the repository, but custom-provider shell commands execute as the local
OS user and are not an independent container sandbox. The UI calls this out and defaults shell to
`ask`; users should choose `allow` only for providers they trust. Codex-backed ChatGPT Masters have
stronger workspace sandboxing, but their individual native tool calls are not mirrored into
Nexestra's `tool.updated` events.

## Status

Accepted for Milestone M9.
