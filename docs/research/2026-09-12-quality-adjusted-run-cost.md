# Research: quality-adjusted run cost

Run history now exposes estimated spend and explicit helpful or needs-work feedback, but those
signals were separate. A filter-scoped cost-per-helpful figure gives the user a direct harness
comparison measure while staying within the existing local telemetry model.

The metric is deliberately conservative: the server emits it only when every matching run has a
provider usage report and complete local pricing, and when at least one reply is marked helpful.
It divides the estimated total by helpful feedback count. Partial coverage, no helpful ratings, or
unknown prices produces no number; the UI displays an em dash. This avoids presenting an incomplete
estimate as a quality benchmark. The browser export carries the typed metric through the existing
run-history packet.
