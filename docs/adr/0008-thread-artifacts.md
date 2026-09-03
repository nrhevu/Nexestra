# 0008 — Thread-scoped uploads and indexed artifact references

## Context

Threads need to carry more than plain text. Users must be able to attach files and images to a
message, find them later, and see links or repository files that either a person or an agent cited.
Artifacts must not introduce a second conversation history or weaken the local file boundary.

## Decision

Keep artifact metadata in the thread's canonical append-only JSONL transcript as
`artifact.created` events. A message records the IDs of its artifacts, and one fsynced append writes
the message event followed by its artifact events before any agent is queued. Store immutable upload
bytes at `.nexestra/artifacts/<thread-id>/<artifact-id>` with private directory and file modes.

Accept multipart messages with no more than 10 files, 20 MB per file, and 50 MB total. Render only
an allowlist of raster image MIME types inline and force every other response to download with
`X-Content-Type-Options: nosniff`. Index HTTP(S) URLs automatically. Also index Markdown-link and
inline-code file paths when their resolved real path is a regular workspace file outside `.git` and
`.nexestra`; repeat the containment check whenever content is served.

The dispatcher supplies artifacts from the exact triggering message to its agent invocation. Codex
uses image arguments, OpenCode uses file arguments, and custom OpenAI-compatible providers receive
bounded text and image content in their protocol-native multimodal shape. Artifact metadata remains
in the shared transcript snapshot for every participant.

The web application renders attachments with their message and adds a searchable, filterable
**Files & links** tab per thread. The tab can preview safe images and open or download artifacts.

## Consequences

Thread history remains self-contained and replayable while binary payloads avoid inflating JSONL.
References to repository files reflect current contents rather than a copied snapshot. Uploaded
content is immutable and survives restart. Artifact deletion is intentionally deferred because
removing bytes referenced by append-only history needs an explicit retention policy.

## Status

Accepted for Milestone M9.
