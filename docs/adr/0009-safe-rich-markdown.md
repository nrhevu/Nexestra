# 0009 — Safe rich Markdown rendering for thread messages

## Context

Agent replies commonly contain headings, emphasis, lists, tables, code, links, and mathematical
notation. Rendering every message as one plain paragraph exposes the source markers and makes long
technical answers difficult to scan. Message source must remain identical for persistence and agent
context, and rich rendering must not turn provider output into executable browser content.

## Decision

Render message content in the React client with `react-markdown`, `remark-gfm`, `remark-math`, and
`rehype-katex`. Support GitHub Flavored Markdown, fenced and inline code, and KaTeX math. Keep the
original Markdown string unchanged in the canonical JSONL transcript and API response.

Do not enable raw HTML parsing. Retain the Markdown renderer's unsafe-URL filtering, replace links
without a safe destination with text, and open external HTTP(S) links with `noopener noreferrer`.
Keep KaTeX trust disabled. Apply Nexestra mention highlighting recursively to rendered prose while
leaving link and code content untouched.

## Consequences

Messages become easier to read without adding server-side HTML or a stored rendered representation.
Historical messages gain rich rendering automatically. The client bundle includes the Markdown and
KaTeX runtimes and fonts. Code blocks are styled and horizontally scrollable but do not yet perform
language-specific syntax highlighting.

## Status

Accepted for Milestone M9.
