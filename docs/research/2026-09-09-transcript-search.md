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
- The UI needs loading/error/partial states, stale-response protection when query or workspace
  changes, and navigation to the matched message in active or archived conversations.

## Work status

The Messages dialog and exact-message navigation are integrated on the dedicated feature branch.
The dialog keeps focus during background refresh, clears stale results when a filter changes,
deduplicates overlapping result pages, and labels partial scans without promising completeness.
Links open `/threads/<id>?message=<id>`, focus the requested message, and preserve archived threads'
read-only state. The same result can be selected again after switching to Files & links.

The server scanner, endpoint, fixtures, acceptance tests and ADR 0034 remain under verification in
the isolated `codex/transcript-search` branch. Integrated API/type verification, the complete check
suite, and real-browser verification remain required before claiming this feature is complete.

## Deliberate limits

- Search is a case-insensitive literal substring, without regex, fuzzy ranking, sender/date syntax,
  or the query language of the reference product.
- Each page scans canonical files again; a live conversation can shift offsets between requests.
  The dialog removes duplicate hits, but this is not a snapshot-stable cursor.
- Opening a result still loads and renders the full thread. Bounded search does not solve the
  separate long-conversation rendering and history pagination problem.
- Search does not scan attachment bytes or Knowledge content. Knowledge text preview is a separate
  explicit read operation, with its own integrity and size checks.
