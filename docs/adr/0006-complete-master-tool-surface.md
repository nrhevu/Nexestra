# 0006 — Complete Master tool surface except LSP

## Context

The first provider-neutral Master harness covered only the repository inspect/edit/verify loop.
A useful general harness also needs structured patching, reusable instructions, progress tracking,
bounded web access, user questions, and an extension protocol. OpenCode's built-in tool boundaries,
custom tool naming, skill layout, permission rules, ignore behavior, and MCP integration provide a
practical reference. LSP is explicitly outside this milestone.

## Decision

Create one dynamic tool session for every custom-provider Master invocation. It owns the static
built-ins, a per-run todo list, discovered skills and custom modules, and connected MCP clients.
Both supported OpenAI protocols receive the same resulting function definitions and send calls
through the same permission, approval, transcript, output-limit, and error path.

Add `apply_patch`, `skill`, `todowrite`, `webfetch`, `websearch`, and `question` alongside the
existing tools. `question` persists a structured prompt and changes the run to `waiting_input`
until the browser posts validated answers. Add skill, todo, web, question, and external permission
keys; state version 3 migrates to version 4 with safe defaults.

Read optional `nexestra.config.json` for wildcard permission restrictions, extra ignore patterns,
the web-search provider, custom tool directories, and MCP servers. Configuration rules may only
tighten the agent profile. Load OpenCode-style module exports from repository and user tool
directories. Prefix MCP tools with their normalized server name, support local stdio and remote
Streamable HTTP through the official TypeScript client, and close clients after every run.

Use ripgrep as the shared file-discovery engine so `.gitignore` and `.ignore` semantics apply to
list, glob, and grep. Hard exclusions for `.git`, `.nexestra`, and credential filenames cannot be
overridden. Web fetch rejects private-network DNS results and redirects, accepts textual responses
only, and caps time and bytes. Tool transcripts store argument keys or sizes rather than custom
tool payloads and file contents.

## Consequences

Custom-provider Masters now have the basic tool surface needed for inspect/change/verify/research
work and can be extended without changing the core registry. Questions and approvals remain visible
in the canonical thread. MCP and custom tools share a conservative `ask` default.

Custom modules are trusted code in the Nexestra server process, while local MCP servers are trusted
child processes. Remote MCP supports explicit headers, including environment references, but not an
interactive OAuth flow. MCP initialization adds startup latency once per Master run. TypeScript
custom tools are limited to syntax Node 24 can load directly. LSP remains unimplemented by design.

## Status

Accepted for Milestone M9.
