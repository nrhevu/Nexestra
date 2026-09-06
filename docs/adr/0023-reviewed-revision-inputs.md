# ADR 0023: reviewed revision inputs

Status: accepted, implemented.

## Problem

An isolated retry received review comments but could lose the document or design being revised.
The newest assignment may also be a failed retry with no review, hiding the last useful feedback.
Reading the old working directory would pick up edits made after the reviewer saw the submission.

## Decision

During assignment admission, the store selects the most recent completed, changes-requested
submission for the same task, thread and contract revision. It records the source assignment,
review ID, task revision and captured output hashes. Supplied provenance cannot override this
host selection. A later failed attempt does not erase that reviewed source.

Before invoking the Worker, validate the source's generated artifact metadata, file type, byte
limit and SHA-256 hash using bounded file-descriptor reads. Copy verified bytes into the new
assignment's inputs directory. Pass those files and review observations to both runtime adapters;
the Worker writes its next submission to outputs. Source artifacts remain unchanged by app actions.
Human acceptance uses the same bounded validation of captured evidence.

The process UI exposes the revision source's captured files. Changed task requirements start a new
scope without silently inheriting the old revision's inputs. A missing, linked, enlarged or changed
captured source fails preparation before another Worker is invoked.

## Consequences and limits

Document/design revisions can survive failure and restart with exact prior bytes and observations.
Copies are working inputs, not accepted outputs, and are not automatically captured as deliverables.
This does not merge repository branches or reconstruct code diffs; those require a separate Git
revision policy. App invariants and file checks are not an OS sandbox for full-access processes.
Failed preparation consumes an admitted goal attempt under the existing documented budget policy.

The OpenCode adapter also stops attaching the entire transcript as a --file argument: it receives
the bounded snapshot and a path for targeted reads, consistent with ADR 0022. Explicit input
artifacts continue to use the runtime's file attachment mechanism.
