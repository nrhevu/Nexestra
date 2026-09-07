# ADR 0026: inspectable task attempts

Status: accepted, implemented.

## Problem

The process dialog only exposed the latest assignment. Prior failures, reviewed files, profiles
and observations were durable but difficult to inspect through the product. Showing current task
requirements beside an old output would also misrepresent the contract that produced it.

## Decision

The task process API accepts an optional assignmentId, verifies that it belongs to the requested
task and returns that attempt's run, tools, captured artifacts and review. Lightweight attempt
summaries use canonical admission order rather than relying on timestamps to identify the latest
assignment. The default remains the latest attempt; ordinary existing clients are unchanged.

The process view offers an attempt selector. Historical attempts display their frozen title,
description and source brief; older records without a contract explicitly report that gap. Existing
reviews remain visible, while execution, new review, edit and delete controls are hidden in history
mode. Selecting Latest attempt returns to current work. Request sequencing prevents late responses
from replacing a newer selection. Server review/admission guards remain authoritative.

## Consequences and limits

Users can compare attempts, inspect original outputs and understand why a revision was requested
without reading raw JSONL. This does not implement content diffs, side-by-side review, redaction of
historical records, replay or rollback. Large histories still share the single-user metadata store;
the attempt selector is not a paginated archive service. No old runtime identity or task scope is
invented when legacy records lack it.
