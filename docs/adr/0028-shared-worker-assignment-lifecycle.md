# 0028 — Shared Worker assignment lifecycle

## Context

Taskboard delegation used a second implementation that called the Worker directly. It bypassed the
per-agent queue, used an unpersisted synthetic user trigger, omitted canonical run and tool events,
and waited for the entire invocation before replying to HTTP. As a result, manual work could overlap
with chat for the same Worker, and the process dialog could not observe or stop newly submitted work.
The intended behavior documented in ADR 0021 was not implemented by that path.

## Decision

Both entry points use one assignment lifecycle. Manual delegation appends a user message containing
the selected Worker's mention and repository reference before creating the assignment and run. It
does not parse task descriptions for additional agent invocations. Master delegation retains its
existing user trigger and Master summary. Every assignment uses its own ID for its branch, worktree,
and canonical run, with the run linked to the durable triggering message.

The manual HTTP endpoint validates handles and returns `202` when the assignment is durably queued.
The existing process stream then exposes queued/running work and Stop. One Worker remains serial
across chat, Master delegation, manual delegation, and verification; different Workers may proceed
in parallel. A task reservation covers asynchronous startup so duplicate clicks cannot create two
assignments. Successful, failed, and stopped work uses the same run/tool persistence and cleanup.
Retrying a failed assignment's run from the thread creates another task assignment with its Worker
and repository. It cannot silently turn an implementation retry into a discussion-mode chat run.

## Consequences and limits

The process response is acceptance, not proof that the Worker has completed. Later failure belongs
to the process view and attention projection. In-memory completion tracking lets shutdown/tests
wait for manual assignment finalization without an unobserved rejected promise.

Queues still live in the server process; restart recovery does not resume execution. Branches and
worktrees remain until explicit cleanup. Previously created manual assignments without canonical
runs are preserved as historical records; this change does not fabricate their missing events.
Persistence across a user message, state metadata, and run events consists of ordered writes rather
than a multi-file transaction. No provider credential or transcript format changes are introduced.

## Validation

Fake-runner acceptance tests cover the same-Worker queue, independent Workers, duplicate starts,
durable triggers before invocation, queued and active Stop, retry after failure, canonical tool
failure/interruption, failed trigger persistence, and the asynchronous HTTP contract. Existing
Master delegation and external-verification tests exercise the shared implementation.

## Status

Accepted for Milestone M9.
