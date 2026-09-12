# Message quality feedback research — 2026-09-12

The product brief names knowledge transfer as a way to cut AI slop. Trace systems such as DeepSeek
Harness preserve what happened, while evaluation tools such as Langfuse expose explicit user feedback
as scores. Nexestra can stay local-first by collecting a small, direct signal before adding any
automatic judge or prompt mutation.

Nexestra now stores one helpful/needs-work rating per agent message, shows it in history, and carries
it through bounded workspace exports. The signal is deliberately observational: it does not claim
that a thumbs-up is a ground-truth evaluation or silently change future agent behavior.

References:

- [DeepSeek Harness](https://www.deepseek.com/harness/en/)
- [Langfuse user feedback](https://langfuse.com/docs/observability/features/user-feedback)
