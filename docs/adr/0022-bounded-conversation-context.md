# ADR 0022: bounded conversation context and explicit retrieval

Status: accepted, implemented.

## Problem

Injecting the whole transcript into every invocation grows cost and noise without improving the
durability of the underlying evidence. Tool rounds can also accumulate text past useful limits.
Silently dropping or summarizing old decisions would make absence of context look like absence
of evidence.

## Decision

Keep canonical transcripts and full exports unchanged. Pack up to 48,000 characters of recent
messages with explicit omissions, preserving chronological order and well-formed Unicode. Keep
the current trigger, work brief and frozen task requirements separate from that packing policy.

Provide a thread-bound read_history tool and local HTTP route for paginated literal search and
complete message chunks. Return stable identifiers and explicit continuation cursors. Count the
complete text payload before each custom provider request and stop above 240,000 characters with
instructions to resume from durable state using narrower queries.

## Consequences and limits

The model can recover older evidence without repeatedly loading it all. It cannot change history,
grant permission from retrieved text, or treat an omitted section as a negative fact. A hard size
stop is visible, rather than a lossy automatic summary during a tool loop.

Character guards are not token accounting or provider-specific context-window guarantees. CLI
harnesses retain their own internal context management. The app still scans thread text on disk;
semantic indexing, summary evaluation and exact context replay are deferred. See
[the context contract](../CONVERSATION-CONTEXT.md) for bounds and recovery behavior.
