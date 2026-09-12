# Workspace recovery manifest research

The deletion preflight now emits a credential-free recovery manifest alongside dependency counts.
It reuses the validated workspace export inventory, hashes each bounded file with SHA-256, and
includes only archive-relative paths for `state.json`, thread transcripts, uploads, Knowledge files,
and the whiteboard. Missing empty transcripts are represented as zero-byte entries; credentials are
never enumerated. The browser can download the JSON manifest without receiving file bytes.

The manifest is evidence for a future transactional delete and rollback design, not a backup or
signature. It is bounded to the existing 5,000-entry and 128 MiB source limits, revalidates file
identity around hashing, and remains a read-only operation. Repository/worktree ownership, tombstone
storage, and post-crash recovery still require a separate implementation.
