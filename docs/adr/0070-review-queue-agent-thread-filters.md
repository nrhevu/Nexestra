# ADR 0070 — Filter the Needs-work queue by agent and thread

## Status

Accepted

## Context

The Needs-work surface can span many conversations and agents. A status filter alone makes it slow
to focus a review session on one provider, worker, or conversation, even though the queue API already
supports workspace-scoped `agentId` and `threadId` predicates.

## Decision

Expose optional Agent and Thread selectors beside the status selector. The selectors use the active
workspace's bootstrap data and send their IDs to the existing review endpoint. Any selection change
loads a fresh first page; keyset cursors remain bound to workspace, status, agent, thread, and limit.
The browser-generated review-case export records the active agent and thread IDs alongside status.

## Consequences

Reviewers can isolate a provider or conversation without changing ratings or source messages. The
selectors show archived threads and agents so historical reviews remain reachable. Labels come from
the already redacted workspace bootstrap projection; the server still validates IDs and workspace
ownership. Filter options are not a second server-side index and therefore reflect the current
bootstrap snapshot.

See the [research note](../research/2026-09-12-review-queue-agent-thread-filters.md).
