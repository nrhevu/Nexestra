# ADR 0115: Make restore preflight server-authoritative

- Status: Accepted
- Date: 2026-09-13

## Context

The browser can inspect a ZIP and compare it with a target inventory, but a future restore must not
trust browser-generated hashes or workspace identity. A malformed or cross-workspace archive must be
rejected before any write path is considered.

## Decision

Add a POST-only, non-mutating `/api/workspaces/:id/import/preflight` endpoint. It bounds the request
body, verifies the ZIP and manifest with the same inspection rules as the browser, checks the
manifest workspace ID against the target, obtains a fresh credential-free target inventory, and
returns the safe/identical/conflict path categories. It performs no state or filesystem mutation.

The recovery inventory hashes the redacted metadata representation used by the archive exporter, so
an unchanged `state.json` is recognized as identical instead of appearing to conflict solely because
credential values are excluded from the archive.

## Consequences

- Restore UI and a future mutation endpoint can use one server-verified plan.
- Cross-workspace archives and invalid ZIPs fail before target writes.
- The endpoint still does not import state or choose overwrite/merge/rollback policy.
