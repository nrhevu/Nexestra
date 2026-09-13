# ADR 0110: Categorize restore preflight path conflicts

- Status: Accepted
- Date: 2026-09-13

## Context

Workspace archive inspection verifies ZIP integrity and can inventory the selected workspace's
current paths, but a path-only collision list cannot distinguish a safe replay from a changed file.
Actual restore remains intentionally deferred because merge and rollback policy are not settled.

## Decision

The read-only restore preflight compares archive manifest entries with a credential-free target
inventory that includes path, byte count, and SHA-256. It reports deterministic, bounded categories:
`safeToCreate` for absent paths, `existingIdentical` for matching bytes and hash, and `conflicts` for
hash or size differences. The existing path-conflict list remains populated from the conflict
category for compatibility. Inventory failures remain visible and never imply a safe result.

The target inventory is produced from the same bounded recovery manifest used by deletion safety
checks. No archive bytes are uploaded and no state or filesystem mutation occurs.

## Consequences

- A future restore implementation can choose an explicit policy for each category.
- Users can see whether a preflight collision is a harmless replay or a data conflict.
- Older target responses containing only paths are treated conservatively as conflicts.
- Merge, overwrite, import, and rollback remain separate decisions.
