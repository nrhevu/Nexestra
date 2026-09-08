# Research: recoverable message submission

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Problem and primary sources

The existing store syncs a user message to JSONL before writing thread metadata. The composer
keeps its draft when a send fails, but the next attempt receives a fresh message UUID. A failed
response can therefore produce another message and another set of agent runs even when the
original request was applied.

[RFC 9110 section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) describes
idempotency in terms of the intended server effect of repeated requests, and explains the
conditions under which a client can retry a request whose method does not supply that guarantee.
It also allows responses to differ even when the intended effect remains the same. This supports
confirming a saved message while reporting its current run state.

[Stripe's idempotency documentation](https://docs.stripe.com/api/idempotent_requests) demonstrates
opaque client keys and rejecting parameter changes under the same key. Its response caching and
retention policy are specific to Stripe. Nexestra instead needs durable identity in its existing
canonical transcript, while separating message confirmation from explicit agent retry.

[MDN's digest documentation](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
describes SHA-256 and the need to supply the complete input to WebCrypto. This supports a byte
digest within the existing upload limits; file names and sizes alone cannot identify an unchanged
attachment. [MDN's localStorage documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
documents policy-related storage failures. Pending-send persistence must therefore report its
availability separately from keeping an identity in the current tab's memory.

These official documentation pages were fetched directly over HTTPS and read locally. The web-search tool
returned HTTP 404. No external search or provider service is added to the product.

## Baseline evidence

An isolated API fixture on baseline `bdecb19` saved a plain note and then deliberately replaced
its successful response with HTTP 503. Sending the same content and request UUID again returned
201 and produced two different saved message IDs. There were no agent mentions and no provider
invocations. This is injected loss of the success response, not a claim about measured network
failure rates.

The earlier history acceptance test separately proves the durable-append/failed-metadata case.
Code review also identifies partial dispatch of several mentions and uploaded files written before
JSONL as boundaries that a request key alone cannot solve.

An early integrated checkpoint passed the lost-response text case, six concurrent submissions,
changed-content conflicts and recovery after a metadata-write failure. The same public HTTP
fixture then found an unprimed-index error: a fresh thread's first upload send succeeded, but its
replay returned 409. This check intentionally creates a new thread and sends immediately, without
opening a history page first. Final acceptance must preserve that ordering.

## Selected implementation

Use a stable browser request identity for a pending send. Store a private canonical receipt with
a server-computed content/upload fingerprint. Serialize concurrent submissions, compare retries
with the saved payload, and return the original message. Reconcile original mentions against
durable runs so replay neither repeats an existing run nor forgets a mention that never reached
dispatch. Keep Knowledge pins and artifact identity from the saved message.

Browser recovery must survive thread changes and preserve text-send identity across reloads.
Attachment descriptors can survive reload; file bytes must be supplied again. A late response
must not clear a newer draft or pending intent. See
[ADR 0039](../adr/0039-recoverable-message-submission.md).

## Verification status

The integrated HTTP fixture now confirms these outcomes:

| Fault or action | Observed result |
| --- | --- |
| Successful response replaced with 503 after persistence | Replay returns 200, one user message and one fake-agent invocation |
| Six simultaneous requests with the same key | One 201 plus five 200 responses, one message and one run |
| Reused key with changed text | 409, with no second message |
| Identical text with two deliberate request IDs | Two separate user messages |
| Metadata write throws after JSONL append | Initial 500; replay confirms the same user message and starts one run |
| Two files on a freshly created thread; success response lost | Replay preserves two artifact records, two stored files and exact downloaded bytes |
| Changed upload bytes, name or order under the original key | 409; original message and files remain |
| Duplicate multipart key fields or invalid UUID | 400 before saving a message |
| Archived saved note | Confirmation succeeds; a new send remains rejected |
| Queued run persisted before enqueue throws | Replay completes the same run ID with one invocation |

Native in-app browser QA used the same fake server. After losing a successful response, the draft
survived navigation to another conversation and a page reload. Sending again used the identical
request ID and message ID; the runner trace contained exactly one invocation. An intentional send
of the same words after confirmation used a new ID and produced a second invocation. The other
conversation's draft remained intact.

A separate native send then failed after metadata persistence was attempted. After a server
restart and page reload, its original draft and request identity were restored; confirmation
returned 200 and the transcript still contained one user message. Two saved API submissions were
also replayed after restart with their original message IDs and run IDs. The full HTTP suite was
rerun after adding stale-index and conflicting-receipt guards and passed again. All fixture servers
and browser tabs were closed afterward.

Every runner in these checks is a deterministic local fixture. No live Codex, OpenCode or custom
provider was called. Faults were deliberately injected, so these observations do not estimate
real-world failure rates. The combined `pnpm check` passes: **514 tests in 38 files**, lint,
TypeScript and production build. New coverage includes 31 store tests, 17 dispatch/API tests,
18 browser submission tests and two deferred-digest tests for newer draft and send-intent ordering.
The combined run also identified UI assertions that read before bootstrap or scheduled focus;
those assertions now wait for the behavior they verify.

## Follow-up candidate

An explicit **Copy message link** action could make the existing message navigation easier to use.
The app already parses `/threads/<id>?message=<id>`, resolves foreign workspace links and loads the
page around a target. The missing convenience is producing that existing URL from a message row;
it does not require another routing format or a new history endpoint. Links would remain local to
the same server and data directory.

[MDN's clipboard documentation](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText)
describes an asynchronous write that can be denied. The action should report success only after
the write resolves and expose the URL for manual copying when unavailable or denied. Acceptance
would cover an old paginated message, a renamed/archived thread, keyboard access, denied clipboard
access and reopening the generated URL. This remains a candidate after submission recovery is
integrated and verified.
