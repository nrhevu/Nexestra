/**
 * Normalising what a reviewer said.
 *
 * Adapters are free to answer in prose, in `final.structured.findings` (what
 * the Codex adapter produces via `--output-schema`) or with a bare JSON array.
 * This module reduces all three to `ReviewFinding[]` so the loop's "is this
 * blocking?" rule has one shape to look at.
 */
import { BLOCKING_REVIEW_SEVERITIES, type ReviewFinding } from "./types.js";

const SEVERITIES: readonly ReviewFinding["severity"][] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normaliseSeverity(value: unknown): ReviewFinding["severity"] {
  if (typeof value !== "string") return "info";
  const lower = value.toLowerCase();
  for (const severity of SEVERITIES) if (severity === lower) return severity;
  if (lower === "blocker" || lower === "error") return "critical";
  if (lower === "warning" || lower === "warn") return "medium";
  return "info";
}

function normaliseFindings(values: readonly unknown[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
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

export interface ReviewResult {
  summary: string | undefined;
  findings: ReviewFinding[];
  blocking: ReviewFinding[];
}

/** Pull findings out of a review run's `final` event. */
export function extractReview(final: { message: string; structured?: unknown }): ReviewResult {
  let summary: string | undefined;
  let findings: ReviewFinding[] = [];

  if (isRecord(final.structured)) {
    const raw = final.structured.findings;
    if (Array.isArray(raw)) findings = normaliseFindings(raw);
    if (typeof final.structured.reviewSummary === "string") {
      summary = final.structured.reviewSummary;
    } else if (typeof final.structured.summary === "string") {
      summary = final.structured.summary;
    }
  }

  if (findings.length === 0) {
    const fromMessage = parseMessage(final.message);
    if (fromMessage) {
      findings = fromMessage.findings;
      summary ??= fromMessage.summary;
    }
  }

  summary ??= final.message.trim().length > 0 ? final.message.trim() : undefined;
  return { summary, findings, blocking: blockingFindings(findings) };
}

function parseMessage(
  message: string,
): { summary?: string; findings: ReviewFinding[] } | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return { findings: normaliseFindings(parsed) };
  if (!isRecord(parsed)) return undefined;
  const raw = parsed.findings;
  return {
    ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
    findings: Array.isArray(raw) ? normaliseFindings(raw) : [],
  };
}

/** Findings severe enough to send the task back to `execute` (PLAN.md §6). */
export function blockingFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter((finding) => BLOCKING_REVIEW_SEVERITIES.includes(finding.severity));
}
