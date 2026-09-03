# 0010 — Align provider-neutral Master behavior with OpenCode tool semantics

## Context

The initial Master harness exposed the requested tool names but differed from OpenCode at several
behavioral boundaries. Models trained to call OpenCode tools could send `filePath`, `oldString`, or
`workdir` and fail Nexestra validation. Large reads and results stopped instead of continuing,
documented custom tools using `@opencode-ai/plugin` did not load faithfully, retry and loop behavior
differed, and calls from one model step ran serially.

The compatibility reference is OpenCode 1.18.18 and the official `dev` source at commit
[`b578b726`](https://github.com/anomalyco/opencode/tree/b578b7261fc9ec4917fe272df5cc4bd8a056cd5d).
The relevant public contracts are the official documentation for
[tools](https://opencode.ai/docs/tools/),
[permissions](https://opencode.ai/v2/docs/permissions),
[custom tools](https://opencode.ai/docs/custom-tools/),
[skills](https://opencode.ai/docs/skills), and
[MCP servers](https://opencode.ai/v2/docs/mcp-servers).

## Decision

Expose OpenCode's canonical arguments for `read`, `grep`, `edit`, `write`, and `bash`, while parsing
the old Nexestra aliases for saved conversations. Read files and directories using OpenCode-style
line-numbered output and continuation offsets. Allow absolute repository paths and exact external
paths from invocation artifacts, loaded skills, or saved tool results; continue to block all other
external paths, symlink escapes, Nexestra private data, and credentials.

Use OpenCode's 2,000-line and 50-KB result boundary. Persist the full redacted result as a private
run file, return a bounded head preview for normal tools or tail preview for shell, and permit only
the active invocation to read that file. Default shell timeout to 120 seconds and allow a bounded
repository working directory.

Depend on the matching `@opencode-ai/plugin` package so documented custom modules load unchanged.
Support raw Zod argument shapes, multiple module exports, rich result objects, singular and plural
tool directories, and the OpenCode execution-context field names. Return skills without YAML
frontmatter and include their base directory and a bounded support-file list.

Execute independent calls from one provider response concurrently, but preserve their response
order. Keep the run waiting while any concurrent approval or question remains unresolved. Stop only
three consecutive identical calls, and retry transient provider failures up to five times with
bounded exponential or server-directed delay. Evaluate ordered workspace permission patterns using
the last matching rule, then prevent them from widening the selected access mode.

## Consequences

The provider-neutral Master now accepts the common tool calls and extension modules that an
OpenCode-oriented model produces, while retaining Nexestra's canonical thread, coarse access modes,
credential redaction, and repository boundary.

This is behavioral compatibility for Nexestra's requested Master tool surface, not an embedded copy
of OpenCode. LSP remains excluded by product decision. Nexestra also does not expose OpenCode's task
subagents or experimental plan/code-mode tools. MCP remains per invocation and does not implement
interactive OAuth, prompts, or resources. Exact edit has no fuzzy fallbacks, formatter hooks, or LSP
diagnostics. Live activity and response transport is defined separately by ADR 0011. Custom tool
metadata and nested permission requests are accepted as no-ops after Nexestra's coarse tool-level
permission check, and custom tool attachments are not promoted into thread artifacts.

## Status

Accepted for Milestone M9.
