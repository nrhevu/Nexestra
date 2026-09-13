# Taskboard prerequisite links research — 2026-09-13

Dependency edges already block unsafe delegation and remain durable on Taskboard tasks, but a card
only exposed `Depends on N task(s)`. A bounded title and status list is the smallest recovery aid:
users can identify the unfinished prerequisite and open its existing process dialog immediately.

The browser should resolve IDs only against the selected workspace's loaded task projection. Show at
most three entries, summarize the remainder, and render missing or foreign IDs as unavailable so
legacy state stays safe and no cross-workspace task metadata leaks into the card.
