# ADR 0017: revisioned work briefs in canonical thread history

Status: Accepted

## Context

The workspace needs shared intent for research, documents, design and code. Task descriptions and
transient Master todos cannot reliably capture scope across sessions. Humans and Masters may edit
simultaneously, and an agent proposal must not impersonate user agreement or completion.

## Decision

Each thread may have one current Work Brief: outcome, deliverables, constraints, non-goals, open
questions and paired success criteria/check descriptions. Every kind uses the same contract and
requires no repository. This is a scope artifact, not an execution state machine.

Persist revisions as `brief.updated` events in the canonical thread JSONL. The latest event is the
projection, with no second copy in `state.json` and no metadata migration. Rebuild the in-memory
index during startup replay and update it only after fsync. Bootstrap must not scan all transcripts
on each activity refresh.

Writes use expected revisions, scoped actor identity, bounds and secret redaction. The store queue
serializes concurrent updates. Conflicts preserve the current version. Every edit returns to draft.
A user may confirm an exact revision when outcome, outputs and checks exist and questions are
resolved. Confirmation records scope agreement; it does not dispatch or grant permissions.

Read/save/confirm are HTTP operations. Provider-neutral Masters receive read/draft hooks bound to
their thread and identity, with no confirmation tool. Every runtime receives the brief as bounded
invocation context. Mention-only dispatch remains intact. The trusted surface metadata catalog
drives navigation, route recognition and command search; executable plugins are separate work.

## Consequences and limits

- Brief revisions are durable without duplicate chat messages. Confirmation is optional and
  distinct from evidence-backed acceptance.
- Codex/OpenCode receive context; only provider-neutral Masters currently have native mutation
  tools. A future bridge will expose the same commands to other runtimes.
- One brief belongs to one thread. Cross-thread goals, frozen contracts, decisions and artifact
  verification are subsequent work.
- The in-memory index assumes a single writer. Manual JSONL edits require restart; multiple servers
  sharing a data root remain unsupported.
- Loopback APIs trust the local OS user. Hook roles do not isolate a full-access shell that can
  contact local services. Strong evaluator isolation needs scoped capabilities and environment
  isolation, not just a missing tool name.

## Verification

Offline tests cover HTTP/mention/tool integration, operation without repository or provider,
context in both CLI adapters and HTTP protocols, conflicts, invalid confirmation, redaction,
workspace isolation, tail recovery and React save/confirm/conflict behavior.
