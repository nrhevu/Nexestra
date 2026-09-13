# ADR 0129: Reviewed plan handoff to Knowledge

- Status: Accepted
- Date: 2026-09-13

## Context

Taskboard plan cards show durable progress, but the result is easy to lose when a plan is complete
or a thread is compacted. A handoff should preserve the decision-relevant metadata without copying
prompts, transcripts, credentials, or local repository paths into shared Knowledge.

## Decision

Each plan summary offers **Save plan as Knowledge**. The browser builds a bounded Markdown document
containing the plan title and ID, progress counts, task titles and statuses, dependency IDs, and
bounded Worker handle/assignment labels. It limits the same 200 plans/200 tasks as the JSON export
and marks truncation in the document. The document is loaded into the existing Knowledge document
dialog as a local Markdown file.

Saving still requires the normal Knowledge name, `#handle`, optional description, and explicit
upload confirmation. No request is made when the card is opened. On success, the selected workspace
refreshes through the existing Knowledge flow. Manually created tasks without plan provenance are
not included.

## Consequences

Plan review has a durable, user-controlled handoff path without introducing runtime approval state.
The handoff remains a snapshot and does not include worker output or verification details; those
remain available through Taskboard and the process dialog.
