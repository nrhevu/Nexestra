# Review queue Knowledge capture research — 2026-09-12

The product brief treats Knowledge as the durable handoff that reduces repeated agent slop. The
existing queue already has a deliberate review step and the existing capture endpoint records the
canonical thread/message provenance. Joining those paths at the queue item removes navigation
friction without introducing another store or silently promoting content.

The queue response intentionally exposes a bounded redacted excerpt. The UI uses that excerpt only
for review context and sends stable IDs to the existing server endpoint, which reads the canonical
transcript before writing a Knowledge document. Naming and description remain explicit user
decisions. This is an implementation decision; no claim about review completion was measured.
