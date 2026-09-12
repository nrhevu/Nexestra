# Run quality attribution research — 2026-09-12

The product brief combines heterogeneous-agent comparison with a Knowledge path that helps users
cut AI slop. The previous feedback slice added a direct user signal; this follow-up checks whether
that signal can be trusted when the harness retries work or coordinates a Master and Worker.

DeepSeek Harness emphasizes traceable append-only runs, while Langfuse documents user feedback as a
separate score attached to an observed generation. OpenTelemetry's GenAI conventions likewise keep
provider usage telemetry distinct from application-level evaluation. Those patterns support a local
design with three explicit boundaries:

1. Keep the canonical transcript authoritative and add the producing run ID to generated replies.
2. Aggregate only ratings that resolve to one exact run; leave ambiguous legacy records out rather
   than silently assigning them to the newest retry.
3. Display helpful and needs-work counts as user signals. Do not turn a small sample into a quality
   score or change routing without a later, explicit evaluation policy.

Nexestra now applies this design in run history. It preserves old transcripts, validates new
provenance against the transcript index, scopes counts through agent/thread/status filters, and
shows the counts beside cost, duration, and token telemetry. A useful next research direction is a
review queue that lets a user turn a rated message into corrected Knowledge or an evaluation case;
that should require an explicit edit/review step so raw agent prose is never promoted silently.

References:

- [DeepSeek Harness](https://www.deepseek.com/harness/en/)
- [Langfuse user feedback](https://langfuse.com/docs/observability/features/user-feedback)
- [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md)
