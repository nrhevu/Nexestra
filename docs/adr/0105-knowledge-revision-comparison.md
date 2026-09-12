# ADR 0105: Compare bounded Knowledge document revisions

Status: Accepted

## Context

Knowledge documents retain explicit revisions so an agent result can become a reviewed, reusable
source. The detail view could preview or restore one revision, but users still had to download two
files to inspect what changed. That made review slower and encouraged copying unverified content.

## Decision

When a document has at least two revisions, show a read-only comparison control. The browser may
select two revision IDs and fetch their existing server previews. If both previews are supported
UTF-8 text, a bounded line diff is rendered with insertion/deletion counts. The diff caps text at
128 KiB, lines at 2,000, dynamic-programming cells at 1.5 million, and output lines at 4,000. If
either revision is binary, invalid UTF-8, or otherwise not previewable, show metadata only. Preview
text remains server-redacted; no revision is changed, restored, or uploaded by comparison.

## Consequences

Reviewers can verify Knowledge changes without leaving Nexestra, while large or binary files retain
a predictable download fallback. The diff is a bounded review aid rather than a patch or merge tool;
deleted revisions and full-file comparisons still require the existing download path.
