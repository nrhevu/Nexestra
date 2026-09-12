# ADR 0063 — Return review queue totals with paged results

## Status

Accepted.

## Context

Needs-work review is a paged, workspace-scoped projection. Before this change, the response exposed
only the current page and a continuation cursor, so the surface could not tell whether the queue was
empty or merely had more items on later pages. That made quality follow-up harder to monitor.

## Decision

Include a `total` count in `ReviewQueuePage`, representing the number of matching items in the
current status, agent, and thread snapshot before pagination. The field defaults to zero when parsed
from an older response for rolling compatibility. The server computes it from the same bounded
redacted item projection used for the page, so it does not expose transcript content or create a
second scan. The UI displays a singular or plural count beside the filter.

## Consequences

Users can see whether more reviews remain without paging through the entire queue. The count is a
snapshot and may change after another client updates feedback; Refresh obtains a new count. It is
not a cross-workspace total and does not replace the coverage warning for unreadable transcripts.
