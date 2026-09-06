# ADR 0025: assignment execution profiles

Status: accepted, implemented.

## Problem

An assignment referenced only a Worker ID. Deleting that profile made process details lose the
Worker identity, and a later profile reusing the same handle could be mistaken for its predecessor.
The selected harness/model overrides are useful evidence when interpreting an output or failure.

## Decision

The dispatcher snapshots the exact Worker object it will invoke when admitting an assignment:
name, handle, harness, configured model/reasoning overrides, SHA-256 of instructions and capture
time. The assignment retains its original Worker ID. The snapshot is immutable through the normal
assignment update API and survives profile deletion, handle reuse and restart.

The process view uses saved attribution and shows configured runtime settings. Additional provenance
details expose the instruction fingerprint. A null override is labeled runtime default rather than
guessing a model. Historical assignments without a snapshot still render; no provenance is invented.

## Consequences and limits

This is configured provenance, not proof of the effective remote model or a reproducible execution
image. Runtime-resolved defaults, provider routing, binary versions, environment/package versions,
full instruction snapshots, exact prompts and billable token/currency accounting remain separate
gaps. No credentials or process environment are copied into this record. A failed preparation may
have a configured profile even though the Worker was never invoked; the UI labels capture at queue
time and keeps execution status separate.
