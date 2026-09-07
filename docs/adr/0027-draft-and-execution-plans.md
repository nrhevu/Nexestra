# ADR 0027: draft plans and execution commitments

Status: accepted, implemented.

## Problem

The plan tool previously put every created task into a must-delegate set. When Workers were
available, a provider that finished a planning-only answer was prompted to execute those tasks.
This could turn analysis/design proposals into work that the user had only asked to consider.

## Decision

Add plan mode, defaulting to draft. Both modes create durable tasks with explicit acceptance
criteria. Draft mode imposes no execution obligation. Execute mode is for work the user requested
the assistant to carry out; its tasks must be delegated or handed to a draft goal before a final
answer. Existing draft-goal handoff still clears that obligation and requires the user to Start.

Instructions tell the Master to distinguish planning from execution and to avoid executing a
planning-only request. Tests for both HTTP protocols prove draft plans can finish without a
delegation callback or corrective execution prompt, while execute mode retains its completion guard.

## Consequences and limits

Mode is a commitment policy, not a new permission grant or a hard authorization boundary. Existing
tool access rules still apply. Known draft task IDs may later be delegated under an authorized
request; durable goals retain their separate user-owned activation gate. This change does not add
perfect semantic intent classification, automatic consent inference or a general policy engine.

Callers that relied on implicit must-delegate behavior should explicitly set mode to execute.
The default changes intentionally so omission cannot impose an execution obligation on a proposal.
