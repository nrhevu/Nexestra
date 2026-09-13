# Upstream harness roadmap signals

Research on 13 September 2026 found two useful directions for Nexestra's next larger initiatives:

- DeepSeek Harness documents plan mode as logged per-agent state with a stable exit tool. The state
  is selected before a turn, visible to clients, and preserved in the session log. This supports a
  future Nexestra plan/review mode that can survive reloads rather than being a transient UI flag.
  Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/plan.md
- Recent Codeg releases emphasize interactive MCP forms, approval cards, durable sub-agent outcome
  cards/session links, and snapshot-backed rollback for restore. These map to Nexestra's remaining
  gaps around custom forms, richer delegated-run inspection, and merge/restore journals. Source:
  https://github.com/xintaofei/codeg/releases

The current implementation already covers declarative surfaces, bounded question/approval flows,
queued-run rehydration, and create-only archive import. The next architecture-heavy work should
prioritize a logged plan-mode state or transactional merge restore, with multi-process leasing kept
separate from the single-process local-first queue.
