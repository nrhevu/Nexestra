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

## Implementation and verification

The Messages dialog, server scanner and exact-message navigation are integrated on the dedicated
`codex/workspace-attention-navigation` branch. The UI and server use the same shared contracts.
The final combined check suite passed; its result is recorded below.

Native-browser verification used one isolated local data directory with a runner that throws if an
agent is invoked. The fixture included two workspaces, an active thread with 57 messages, an
archived thread with 61 messages, never-used general threads, and three Knowledge documents.

- Searching “cobalt window” in Search QA returned three hits (user/agent and active/archived).
  The same phrase in Client Notes returned only its one message. Thread/archive filters worked.
- A result in the middle of the archived thread opened the stable message URL, highlighted and
  focused the selected group at about y=411..467 in a 720px viewport. Reload kept that location.
  Opening the link from the other saved workspace resolved the correct workspace and message.
  Show latest cleared the query and resumed the latest-message view; archive remained read-only.
- A 55-hit search returned 50 initial results, then five more. All 55 rendered identities were
  distinct and the continuation control disappeared at the end.
- A malformed line was temporarily appended to the isolated fixture. A no-hit search showed the
  explicit incomplete-result message, without claiming an exhaustive empty result. The fixture
  was then restored exactly, with a byte-equality guard against overwriting another change.
- Browser verification found an initial-query request cancelled by React StrictMode's development
  lifecycle. Cleanup now resets the one-shot initialization guard; a StrictMode regression test
  and a fresh browser dialog both confirm automatic search completes.
- Light/dark screenshots were inspected. The modal header now follows the theme, and the result
  list scrolls without pushing the query and filters behind a sticky header. Keyboard focus
  remains within the dialog.
- SHA-256 snapshots of all eight fixture files (state, three canonical transcripts, and four
  immutable document files) matched before and after search/navigation and Knowledge previews.
  No live provider was used.

Knowledge preview verification is recorded in the [preview report](2026-09-09-knowledge-preview.md).

### Combined gate

`PATH=/opt/homebrew/bin:$PATH NODE_OPTIONS=--no-experimental-webstorage pnpm check` passed on
9 September 2026 after the final credential-compatibility fix and UI integration: lint checked
68 files, TypeScript passed, **361 tests in 29 files passed**, and client/server production builds
completed. Tests and browser fixtures used no Codex/OpenCode process or live provider credentials.

The integration also preserves legacy credential-file compatibility: an unusually large saved
credential disables only the bounded preview, with a download fallback, rather than preventing
the store from reopening.

## Deliberate limits

- Search is a case-insensitive literal substring, without regex, fuzzy ranking, sender/date syntax,
  or the query language of the reference product.
- Each page scans canonical files again; a live conversation can shift offsets between requests.
  The dialog removes duplicate hits, but this is not a snapshot-stable cursor.
- The initial search implementation opened the full thread. The follow-up
  [conversation history change](2026-09-09-conversation-history.md) loads a bounded page around the
  result; search scanning and its offset limitations are unchanged.
- Search does not scan attachment bytes or Knowledge content. Knowledge text preview is a separate
  explicit read operation, with its own integrity and size checks.
