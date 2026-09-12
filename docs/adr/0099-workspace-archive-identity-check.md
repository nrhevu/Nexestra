# ADR 0099: Check workspace identity during local archive inspection

Status: Accepted

## Context

Nexestra can verify an exported ZIP locally, including its manifest coverage, CRC values, and
SHA-256 payload hashes. The archive manifest also carries the source workspace identity. A user who
has several workspaces can therefore verify a healthy archive and still open the wrong snapshot
without a clear signal. The archive remains a manual snapshot: import and restore are not supported.

## Decision

When the archive inspector is opened from an active workspace, pass that workspace's bounded ID and
name to the browser Worker. The inspection report includes an optional `workspaceMatch` object. The
ID comparison is the identity check; the name comparison is informational and never replaces the ID.
A verified archive whose ID differs shows a visible warning while preserving the successful integrity
result. Legacy callers that do not provide an expected workspace keep the previous report shape.

No archive contents are uploaded, imported, or written. The check only compares identity already
present in the manifest, and does not turn hashes into an authenticity or restore guarantee.

## Consequences

Workspace switching and archive review are less error-prone, especially when snapshots have similar
names. The additional metadata is bounded and contains no transcript contents or credentials. A
matching identity still means only that the archive claims the active workspace; users must continue
to treat the ZIP as a manual, integrity-checked snapshot.
