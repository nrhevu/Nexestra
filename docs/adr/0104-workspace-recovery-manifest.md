# ADR 0104: Add a read-only workspace recovery manifest

Status: Accepted

## Context

The deletion preflight shows workspace counts, but counts alone are not enough to verify a later
move-to-trash operation or recover from a partial failure. A recovery record must identify the
bounded files that belong to the workspace without copying their contents or exposing credentials.

## Decision

Extend the deletion preflight with a typed recovery manifest. The manifest includes a version,
workspace identity, creation time, total byte count, and archive-relative entries for state metadata,
transcripts, uploads, Knowledge files, and the whiteboard. Each entry includes its byte count and a
SHA-256 digest. The server derives it from the same validated, bounded file set used by workspace
export, rechecks file identity around hashing, and excludes `credentials.json` and credential values.
Settings can download the JSON manifest locally. The operation is read-only and remains bounded by
the existing 5,000-entry and 128 MiB limits.

## Consequences

Users have durable evidence for a future transactional move-to-trash or rollback operation, and
repeated snapshots can compare file identity without reading content into the browser. Hashes do not
prove authenticity, and the manifest is still a point-in-time snapshot; actual deletion must
revalidate under a write barrier and define recovery of repositories, worktrees, and credentials.
