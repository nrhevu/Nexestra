# ADR 0045 - Workspace run history

## Status

Accepted.

## Context

Needs attention projects current decisions and task failures. Ordinary completed, failed and
interrupted chat runs remain in their conversations, making it difficult to find an earlier run
without remembering its thread. Canonical transcripts already contain durable run lifecycle events;
the server primes an offset index from those same files at startup.

## Decision

- Add a workspace-scoped `GET /api/runs` listing with optional agent, conversation and status
  filters. Include archived conversations and all seven run statuses. Return one latest lifecycle
  summary per run, with its attempt, timestamps, canonical trigger ID and current metadata labels.
  A retry has its own run ID and therefore its own row. Omit error text, messages, tool payloads,
  input and output from this listing; reuse existing secret redaction for display labels.
- Attach an in-memory summary map to each canonical transcript index. Build it during the existing
  startup scan and update it after durable appends, including restart recovery events. Persist no
  second run database. A warm listing reads summaries rather than full transcripts.
- Order by creation time descending, then run ID and thread ID ascending, using code-unit
  comparisons. Use an opaque, validated keyset cursor bound to the workspace, filters and page
  limit. Default to 50 summaries and allow at most 100. Status updates do not move an existing run
  in creation order; new runs do not shift the cursor into an older page.
- Validate workspace ownership of filters, labels and indexed run identities. Exclude a damaged,
  missing nonempty or inconsistent conversation as a whole and report incomplete coverage with
  its count. A known empty conversation with no transcript is valid. A conversation filter scopes
  coverage to that conversation; agent and status filters cannot establish what an unavailable
  conversation contained, so their coverage still includes all workspace conversations.
  Startup summary repair preserves known nonempty metadata when the file is missing, including
  across a second restart; an absent transcript must not be converted into an empty conversation.
- Add Run history under Surfaces and `/runs` or `/run history` commands. The view keeps one page
  of run objects and a cursor-only back stack. Older and Newer fetch and replace the current page.
  Filters and explicit Refresh return to the newest page. Workspace switches reset local filters
  and page state. Request identity, abort and a 30-second deadline reject late or stuck responses.
  Effect cleanup resets request deduplication state, and initial dispatch yields one microtask so
  React StrictMode replay cancels the discarded setup before issuing one surviving request.
- Open run navigates to the existing stable message link for its canonical trigger, including in
  archived conversations. It preserves app-owned drafts and selected files. Run history itself
  does not retry, approve, cancel or invoke work; existing conversation controls own those actions.
- Global Refresh and workspace resume refresh the mounted run listing after metadata revalidation.
  Both return to the newest page while keeping the filters. The list does not continuously poll.
  A workspace switch unmounts the old list immediately, before
  the new bootstrap finishes, so stale rows cannot open a conversation in another workspace.
  If the current switch fails, restore the last loaded workspace and retain the visible error;
  Refresh and another attempt at the target workspace remain available. A superseded failure
  cannot roll back a newer switch.

## Verification

The combined acceptance tests and native browser observations are recorded in the
[research and QA record](../research/2026-09-09-workspace-run-history.md).

## Limits

The projection adds O(runs) process memory, alongside the existing offset index. Each listing
collects and sorts matching summaries under the store's write serialization, with O(R log R)
sorting in the number of matching runs. A bounded response does not imply a bounded startup scan
or constant-time workspace query. Very large histories may need a separately designed index.

Coverage describes the cached canonical projection. Files edited, deleted or repaired outside the
running server require a restart to be reflected reliably; this endpoint does not stat every
transcript on each request. Pages are live views, not a frozen snapshot: status changes can add or
remove matches, and Newer refetches may show different rows. The cursor stack grows with pages
visited, while run objects and DOM rows remain bounded to one page.

Deleted agents appear as Unknown and cannot be selected in the current-agent filter. Filters and
page position are not saved in the URL or restored after leaving the surface. A missing trigger
uses the conversation's existing unavailable-target fallback. There is no cross-workspace inbox,
background notification, full-text run search, duration metric or new run action in this change.
