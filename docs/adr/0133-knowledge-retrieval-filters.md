# ADR 0133: Local Knowledge retrieval filters

- Status: Accepted
- Date: 2026-09-13

## Context

As plan handoffs and reviewed notes accumulate, scanning every Knowledge card becomes slow. The
selected workspace already provides bounded metadata for each item, so retrieval can stay local and
avoid another server or file-byte scan.

## Decision

Knowledge adds a case-insensitive search field and kind tabs for All, Documents, and Repositories.
Search matches only the selected workspace item's name, `#handle`, description, document filename,
or repository source. The existing detail, download, and create actions remain unchanged. A
matching count and explicit no-results state make the active filter visible.

## Consequences

Knowledge handoffs are easier to find as the library grows without exposing transcript content or
reading document bytes. Filtering is client-side over the already loaded selected-workspace
projection; pagination and full-text search remain future work.
