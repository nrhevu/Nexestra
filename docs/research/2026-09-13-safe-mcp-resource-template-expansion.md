# Safe MCP resource-template expansion research — 2026-09-13

MCP resource templates extend the cataloged read surface with a model-supplied URI variable. The
previous path replaced known placeholders and ignored extra map entries, while a missing or invalid
value could result in an unintended URI or an oversized request.

The template tool now performs a bounded deterministic expansion: exact catalog membership is
checked first; placeholder names and supplied keys must match; scalar values are bounded and free of
control characters; and URI encoding happens before substitution. Missing and extra variables fail
without calling the server. The existing catalog allowlist, timeout, and response-size boundaries
are unchanged. Full RFC 6570 expression support and template mutation remain future work.
