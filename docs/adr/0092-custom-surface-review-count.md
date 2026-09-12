# ADR 0092 — Custom surface review count

## Status

Accepted.

## Decision

Bootstrap data includes the selected workspace's count of open Needs-work reviews. Declarative custom
surface cards for `reviews` render that count alongside the existing workspace-scoped counts.

The server obtains the count through the bounded review queue projection, so malformed or unavailable
transcripts contribute no message content. The count is refreshed with bootstrap and normal app
refreshes; custom surfaces do not add a separate polling loop.
