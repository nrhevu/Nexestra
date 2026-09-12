# ADR 0102: Compare restore preflight paths with a local workspace target

Status: Accepted

## Context

The read-only archive preflight inventories snapshot contents but previously could not tell whether
those paths already exist in the selected local workspace. Treating an empty conflict list as clean
would be unsafe, while uploading the archive to the server would weaken the browser-local inspection
boundary.

## Decision

Expose a GET-only target inventory for a workspace. The server reuses the existing export capture
ownership checks and returns only bounded archive-relative paths (`state.json`, transcripts, artifacts,
documents, revisions and whiteboard). The archive dialog requests this list only after the user
chooses **Plan restore**, then intersects it with the already verified manifest in the browser.

The archive bytes never leave the browser, and the endpoint cannot write or mutate state. The response
marks the conflict set checked only after a schema-validated inventory succeeds; failures leave the
set unchecked and visible. Credentials, repository clones, worktrees and unknown paths are not part
of the inventory.

## Consequences

A user can identify real path collisions for the selected local workspace before any future restore
operation. The target inventory is a snapshot and can change before a later mutation, so it is a
preflight signal rather than a lock or merge decision. Actual import, conflict resolution and rollback
remain deferred.
