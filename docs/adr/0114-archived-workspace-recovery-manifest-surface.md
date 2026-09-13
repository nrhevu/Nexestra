# ADR 0114: Expose archived workspace recovery manifests read-only

- Status: Accepted
- Date: 2026-09-13

## Context

Reversible workspace archival hides a workspace from normal navigation while preserving its local
data. Settings could restore an archived workspace, but offered no way to inspect its bounded file
inventory before making that state change.

## Decision

Settings lists archived workspaces with a read-only **View manifest** action. The action calls a
workspace-scoped recovery-manifest endpoint, which returns bounded path, byte-count, and SHA-256
metadata without activating the workspace or mutating state. The UI shows a bounded first 20 entries
and keeps restore as a separate explicit action.

## Consequences

- Users can inspect archived data ownership and integrity before restoring.
- Recovery manifests remain credential-free and do not expose file bytes or transcript contents.
- Full archive import, merge policy, and rollback remain separate workflows.
