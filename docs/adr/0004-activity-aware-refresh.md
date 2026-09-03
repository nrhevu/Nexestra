# 0004 — Activity-aware refresh without idle polling

## Context

The first workspace UI refreshed the full bootstrap and selected thread every five seconds while
idle, and every second while an agent worked. A bootstrap checked runtime availability and scanned
every thread transcript for active runs. In the browser, composer and search keystrokes also caused
large transcript or application subtrees to render again. These costs grew with the number of
threads, runs, and messages even when no state had changed.

## Decision

Do not schedule periodic requests for an idle workspace. Poll only the visible thread while it has
queued or running runs. If active work continues outside the visible thread, poll a lightweight
`GET /api/activity` projection and refresh bootstrap once after the projection becomes empty.

The dispatcher owns the in-memory projection of runs queued by the current process. Durable
`run.updated` events remain in the canonical thread JSONL, and startup recovery resolves any run
that predates the process, so the projection is an optimization rather than a second source of
truth. Cache harness and ChatGPT status for 30 seconds; the authentication flow clears that cache
when it needs current login state.

Keep search input state inside the top bar. Render the transcript behind a memoized component
boundary and group latest runs by trigger in one pass before rendering message rows.

## Consequences

An idle browser produces no polling traffic, active chat avoids repeated workspace-wide scans, and
typing no longer rebuilds the full transcript or application. Background activity still becomes
visible without a full bootstrap every second. Runtime installation or login changes made outside
Nexestra may take up to 30 seconds to appear unless the login flow explicitly invalidates the cache.
The live projection is intentionally process-local and is rebuilt through normal new dispatch;
restart recovery remains based on the durable transcript.

## Status

Accepted for Milestone M9 and amended by ADR 0011, which replaces active-thread polling with SSE
when EventSource is available while retaining the idle and background behavior described here.
