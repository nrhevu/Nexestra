# Decision router

- Direction: a general-purpose workspace for research, documents, design and code. See
  [product vision](docs/PRODUCT-VISION.vi.md) and [target harness design](docs/HARNESS-DESIGN.md).
- Implemented: [ADR 0017](docs/adr/0017-thread-work-briefs.md) makes shared intent a revisioned
  thread artifact. Confirmation is scope agreement, not execution permission or task acceptance.
- Implemented: [ADR 0018](docs/adr/0018-versioned-task-acceptance.md) separates run completion from
  task acceptance and binds review to frozen task requirements.
- Implemented: [ADR 0019](docs/adr/0019-general-work-execution.md) unifies execution and captures
  non-Git deliverables for review.
- Planned: executable verifiers, durable goals and declarative extensions. The
  [roadmap](docs/ROADMAP.md) records actual implementation status.
- Existing decisions and supersessions remain in the [ADR index](docs/adr/0000-index.md).
# 2026-09-06: Declarative shared surfaces

Validated manifests describe table/board/canvas/document views with typed records. Host-owned
commands serve humans and the Master; writes use revisions and existing edit permissions. Custom
field values never certify task acceptance. Import/export is usable today; executable renderer
plugins remain a separate future boundary. See ADR 0020 and docs/SURFACE-EXTENSIONS.md.
