# ADR 0040 - Workspace revalidation on return

## Status

Accepted.

## Context

An idle workspace deliberately has no polling timer. Thread SSE starts only after the browser
already knows that thread has active runs; background activity polling likewise requires known
work. Changes made through another client can therefore remain invisible after returning to a
previously idle Nexestra window. Existing automatic EventSource reconnect cannot discover work
when there is no open source to reconnect.

Code inspection and two regression tests on `ee021c2` establish the gap: dispatching window focus
does not fetch bootstrap or history after an externally saved message. A preliminary browser
fixture also retained stale metadata, but its tab-switch command did not actually change window
focus; that observation is not counted as proof of a physical return event.

## Decision

- Revalidate the selected workspace when its window regains focus, when the document becomes
  visible, and on a network-online event while visible. Provide an explicit **Refresh workspace**
  action for the same operation. Initial mounting retains its existing bootstrap path.
- Coalesce related lifecycle events within 400 ms, with one active cycle and at most one queued
  follow-up. Check visibility when automatic work starts and discard queued automatic work on
  hide. Preserve active-thread SSE, background-run supervision and the absence of idle polling.
- Bound each resume cycle to 30 seconds. Abort its bootstrap/history reads and retire the cycle
  at the deadline so a hung response cannot block Retry. Workspace changes and unmounting also
  retire old cycles; aborted response bodies cannot update metadata or the visible history page.
- Read fresh bootstrap metadata and the visible conversation's existing history intent. Surfaces
  need metadata only. Preserve drafts, pending submissions, file selections, open forms, route,
  linked message, and the currently selected history page. Revalidation is a read operation.
- Apply results only within their captured workspace generation and request ordering. A late
  bootstrap cannot restore obsolete activity or trigger an old page load after the user has
  navigated. A newer page, thread or workspace action keeps ownership of its view.
- Keep the existing view usable on failure and expose a retry action. Report actual failures,
  distinguish cancelled or superseded work, and clear failure state after a successful retry or
  workspace switch. A network-online event is a prompt to attempt a read, not evidence that the
  local server is reachable.
- Continue loading Files & links through its existing on-demand inventory path. Refreshing
  Messages must not introduce a full-thread read. Artifact count changes can refresh an already
  open inventory through the existing mechanism.

## Verification

Acceptance tests cover resume/manual refresh, hidden and coalesced events, failure and retry,
draft/pending-send preservation, old history anchors, surface-only reads, cleanup, deadlines and
superseded requests. The integrated `pnpm check` passes 545 tests across 41 files, lint, typecheck
and production build.

An isolated real server and Chromium browser verify external metadata, messages, approval state,
open file inventory, failures and explicit keyed confirmation. The browser tool keeps both tabs
focus-emulated, so testing toggles Chromium focus emulation off/on to produce a focus event without
reloading. This is not a physical OS sleep/wake or tab-return test. Read counts, canonical JSONL
and attachment bytes support the browser observations; all agent invocations use a fake runner.
See the [research and verification report](../research/2026-09-09-workspace-resume-revalidation.md).

## Limits

- This discovers changes on return, reconnect hints or explicit refresh. It is not continuous
  change delivery between idle clients or cross-workspace monitoring.
- Refreshing metadata is not a filesystem rescan. External transcript editing still follows the
  store's existing conflict and restart rules; the server remains a single-process application.
- Existing runtime-status caching and active-run transport behavior retain their own boundaries.
- Browser focus and visibility are different signals, and browser online status cannot establish
  server reachability. Responses, rather than lifecycle events, establish successful revalidation.
