# 0078 — Opt-in refresh for the newest run-history page

## Status

Accepted

## Decision

Run history offers an unchecked **Auto-refresh newest page** control. While enabled, the browser
refreshes the current filtered first page every 15 seconds, skipping requests already in flight.
When the user is viewing older pages, the timer pauses until they return to the newest page. Leaving
the surface or disabling the control clears the timer.

## Consequences

Monitoring active runs can stay current without manual clicks, while network activity remains an
explicit user choice. Existing filters, pagination, and server-side cursor semantics are unchanged;
older pages are not replaced underneath the user.
