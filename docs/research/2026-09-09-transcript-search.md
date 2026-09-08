# Research: finding remembered messages across thread history

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Observed product gap

`src/web/TopBar.tsx` filters thread names, agent names/handles, task titles, and Knowledge
names/handles from bootstrap metadata, then keeps eight results. It does not search message text.
After adding reversible archive, older conversations remain readable but remembering a phrase from
a conversation is still insufficient to find it.

## Evidence and selected direction

[Slack's search documentation](https://slack.com/help/articles/202528808-Search-in-Slack) describes
finding remembered phrases and narrowing results by conversation, sender and other filters. The
selected Nexestra direction is literal message-content search with explicit workspace/thread/archive
filters. Using those filters in a local application is our design choice; this does not promise
Slack's entire query language or its ranking behavior.

[Node 24's readline documentation](https://nodejs.org/docs/latest-v24.x/api/readline.html) describes
reading files one line at a time, handling CRLF delimiters and closing an interface with an abort
signal. It also warns that input-stream errors are not forwarded by its async iterator and that the
line-event API can be preferable when performance matters. Therefore a transcript scanner needs
explicit input error handling and byte/line limits; simply calling `readFile` or relying on iterator
termination is insufficient for a bounded, cancellable search.

The web search tool again returned an HTTP 404 error. Both linked official pages were fetched
directly over HTTPS and read locally. No external search service or provider is part of this design.

## Acceptance criteria

- Search user and agent `message.created` content in the current workspace, including archived
  threads by default. Allow a specific thread and active/archived filtering without crossing
  workspace boundaries.
- Return a bounded contextual snippet, author/time, stable message and thread IDs, and current
  thread name/archive state so renaming does not break navigation.
- Read canonical JSONL files without writing an index, copying message history, changing counters,
  invoking agents, or inspecting credentials, tool outputs or uploaded file bytes.
- Handle unknown, malformed, oversized and torn stream lines deliberately. Bound query length,
  scan bytes, line size and results; missing/unreadable files must not leak filesystem paths.
- Any budget or read error that prevents complete results must be visible in the response and UI.
  A partial scan must never be presented as proof that no messages match.
- The eventual UI needs loading/error/partial states, stale-response protection when query or
  workspace changes, and navigation to the matched message in active or archived conversations.

## Work status

The server contract, scanner, HTTP endpoint, fixtures, acceptance tests and ADR 0034 are delegated to
the isolated `codex/transcript-search` branch. The exact response contract and continuation policy
are being reviewed before UI integration. This feature is not yet part of the verified application.

UI implementation, integrated tests and browser verification remain required after the server slice.
