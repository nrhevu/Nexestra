# Explicit review resolution research — 2026-09-12

The first review-queue slice recovered needs-work replies but was read-only. A usable quality loop
needs a reversible acknowledgement that preserves the original rating and note. The design follows
the local-first rule that canonical transcript and feedback records remain authoritative while UI
state records the user's deliberate review action.

Resolution is a metadata update, not a content rewrite: open items are shown by default, resolved
items remain inspectable, and reopening is possible. The server rechecks message identity and
workspace/provenance before writing, so a stale or crafted request cannot resolve another message.

Automatic Knowledge capture, evaluation export, and prompt mutation remain out of scope until a
separate policy defines what a reviewed correction means.
