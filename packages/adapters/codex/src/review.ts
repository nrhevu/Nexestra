/**
 * `codex exec review` support.
 *
 * The recorded review run returned its findings as **prose** in the final
 * `agent_message` and reported all-zero usage (`docs/harness-protocols.md`
 * §1.7). To get machine readable findings the adapter passes an
 * `--output-schema`; `RunSpec.outputSchema` overrides the default below.
 */
import type { JsonSchema } from "@nexestra/core";
import { isRecord } from "./types.js";

export const REVIEW_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface CodexReviewFinding {
  title: string;
  severity: ReviewSeverity;
  /** Path relative to the review root, or null when the finding is repo-wide. */
  file: string | null;
  line: number | null;
  body: string;
}

/**
 * Default schema handed to `codex exec review --output-schema`.
 *
 * Every property is listed in `required` and `additionalProperties` is false,
 * because OpenAI structured outputs reject anything looser; optional values are
 * expressed as nullable types instead.
 */
export const CODEX_REVIEW_FINDINGS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "file", "line", "body"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: [...REVIEW_SEVERITIES] },
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          body: { type: "string" },
        },
      },
    },
  },
};

export interface ParsedReview {
  summary: string | undefined;
  findings: CodexReviewFinding[];
}

/**
 * Best-effort extraction of findings from a review's final message.
 *
 * Accepts `{summary, findings:[…]}`, a bare `[…]`, or prose (in which case the
 * findings list is empty and the caller keeps `final.message` as the answer).
 */
export function parseReviewFindings(message: string | undefined): ParsedReview | undefined {
  if (message === undefined) return undefined;
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }

  if (Array.isArray(parsed)) {
    return { summary: undefined, findings: normaliseFindings(parsed) };
  }
  if (!isRecord(parsed)) return undefined;
  const raw = parsed.findings;
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    findings: Array.isArray(raw) ? normaliseFindings(raw) : [],
  };
}

function normaliseFindings(values: readonly unknown[]): CodexReviewFinding[] {
  const findings: CodexReviewFinding[] = [];
  for (const value of values) {
    if (!isRecord(value)) continue;
    const title = typeof value.title === "string" ? value.title : undefined;
    const body = typeof value.body === "string" ? value.body : undefined;
    if (title === undefined && body === undefined) continue;
    findings.push({
      title: title ?? "Finding",
      severity: normaliseSeverity(value.severity),
      file: typeof value.file === "string" ? value.file : null,
      line: typeof value.line === "number" ? Math.trunc(value.line) : null,
      body: body ?? title ?? "",
    });
  }
  return findings;
}

function normaliseSeverity(value: unknown): ReviewSeverity {
  if (typeof value !== "string") return "info";
  const lower = value.toLowerCase();
  for (const severity of REVIEW_SEVERITIES) {
    if (severity === lower) return severity;
  }
  if (lower === "blocker" || lower === "error") return "critical";
  if (lower === "warning" || lower === "warn") return "medium";
  return "info";
}
