# ADR 0018: Versioned task contracts and human acceptance

Status: Accepted. Date: 2026-09-07.

## Context

A Worker could mark a task Done by returning any nonempty final response. General-purpose work
needs observable acceptance criteria, and process completion is not evidence that they passed.

## Decision

Tasks carry a work kind, contract revision and behavior/verification pairs. Assignments freeze a
copy at dispatch. Active assignments prevent changing requirements, and assignment creation
atomically enforces one active attempt per task. Dispatch also compares the revision it read.
A successful assignment moves its task into `in_review`, never directly to `done`.

`POST /api/tasks/:id/review` accepts a local-user decision against the latest completed assignment
and exact task revision. Acceptance requires a nonblank observation for each distinct criterion
and review notes. Changes requested returns the task to To do. A review is immutable; further
work uses a new assignment. Editing requirements increments the revision and reopens assigned
work. PATCH cannot bypass review by moving an assigned task to Done.

The Master plan tool now requires structured criteria. Workers receive these criteria in their
assignment prompt. There is no agent-facing accept tool. Existing tasks load with revision 1,
kind mixed and empty checks; old assignments without a contract are displayed but cannot be
retroactively accepted. Purely manual tasks retain manual completion, labeled separately.

## Verification

Offline store/API tests cover missing/duplicate evidence, stale edits and reviews, concurrent
assignment admission, active-contract protection, immutable review history, restart recovery,
manual completion and Origin/actor rejection. UI tests cover evidence collection and preserving
notes on a stale review. Existing dispatcher tests assert `in_review` on Worker completion.

## Limits

Human observations are supplied by the user, not executable or independently measured checks.
Evidence is pinned to an assignment and contract, but output bytes are not yet snapshotted.
Full OS shell access can reach local files and APIs; absence of an accept tool is a routing rule,
not a security boundary against a malicious full-access agent. Strong verifier isolation and
artifact-bound executable checks remain separate work. State assumes one local server process.
