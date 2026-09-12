# Over-budget run filter research — 2026-09-12

The cost budget signal made expensive runs visible, but a large history still required scanning every
row. A server-side filter lets users focus on runs whose observed estimate exceeded the configured
agent limit while preserving the existing workspace, agent, thread, status, and cursor boundaries.

The implementation filters only when both usage and pricing are available, leaves unknown spend out
of the result rather than guessing, and records the selection in exports. It does not enforce a
provider budget or alter dispatch behavior.
