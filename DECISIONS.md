# Decision router

- Direction: a general-purpose workspace for research, documents, design and code. See
  [product vision](docs/PRODUCT-VISION.vi.md) and [target harness design](docs/HARNESS-DESIGN.md).
- Implemented: [ADR 0017](docs/adr/0017-thread-work-briefs.md) makes shared intent a revisioned
  thread artifact. Confirmation is scope agreement, not execution permission or task acceptance.
- Implemented: [ADR 0018](docs/adr/0018-versioned-task-acceptance.md) separates run completion from
  task acceptance and binds review to frozen task requirements.
- Implemented: [ADR 0019](docs/adr/0019-general-work-execution.md) unifies execution and captures
  non-Git deliverables for review.
- Implemented: declarative surfaces, durable goals and bounded conversation context. Planned:
  executable verifiers, graph coordination and isolated renderer plugins. The
  [roadmap](docs/ROADMAP.md) records actual implementation status.
- Existing decisions and supersessions remain in the [ADR index](docs/adr/0000-index.md).
# 2026-09-06: Declarative shared surfaces

Validated manifests describe table/board/canvas/document views with typed records. Host-owned
commands serve humans and the Master; writes use revisions and existing edit permissions. Custom
field values never certify task acceptance. Import/export is usable today; executable renderer
plugins remain a separate future boundary. See ADR 0020 and docs/SURFACE-EXTENSIONS.md.
# 2026-09-06: Durable review-driven goals

Goal scope/brief and budgets survive sessions. Human task acceptance supplies independent loop
continuation; models may propose/read goals but cannot start them or enlarge limits. Restart pauses
work without replaying ambiguous effects. Pause retains usage/deadline and still permits reviewing
submitted outputs. See ADR 0021 and docs/GOALS.md; graphs, executable verifiers and token accounting
remain future work.

# 2026-09-06: Bounded conversation context

Preserve the complete canonical transcript, pack recent messages with explicit omissions, and
retrieve older evidence through a thread-bound read tool. Pinned intent remains separate. Stop
oversized custom HTTP requests before sending; character limits do not claim token accounting.
See ADR 0022 and docs/CONVERSATION-CONTEXT.md.
