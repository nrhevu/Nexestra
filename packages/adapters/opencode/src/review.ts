/**
 * Review mode (`RunSpec.kind === "review"`).
 *
 * OpenCode has no `review` subcommand: a review is an ordinary session run with
 * a reviewer agent, a read-only permission ruleset and a prompt that asks for
 * findings as JSON in a fenced block. The block is preferred over
 * `format:{type:"json_schema"}` because structured output depends on the
 * provider, while a fenced block works everywhere — and `AssistantMessage.
 * structured` is still read first when the model did produce it.
 */
import type { JsonSchema, ReviewTarget } from "@nexestra/core";
import { z } from "zod";

export const REVIEW_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

const SeveritySchema = z.preprocess((value) => {
  if (typeof value !== "string") return "info";
  const lower = value.toLowerCase().trim();
  if ((REVIEW_SEVERITIES as readonly string[]).includes(lower)) return lower;
  if (lower === "blocker" || lower === "error" || lower === "fatal") return "critical";
  if (lower === "warning" || lower === "warn") return "medium";
  if (lower === "nit" || lower === "note" || lower === "suggestion") return "low";
  return "info";
}, z.enum(REVIEW_SEVERITIES));

const NullableString = z.preprocess(
  (value) => (typeof value === "string" && value.length > 0 ? value : null),
  z.string().nullable(),
);

const NullableLine = z.preprocess((value) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}, z.number().int().nullable());

export const OpenCodeReviewFindingSchema = z.object({
  title: z.string().min(1),
  severity: SeveritySchema,
  file: NullableString,
  line: NullableLine,
  body: z.string(),
});
export type OpenCodeReviewFinding = z.infer<typeof OpenCodeReviewFindingSchema>;

/** Tolerant shape: a model that omits `body` or `severity` still parses. */
const LooseFindingSchema = z
  .object({
    title: z.string().optional(),
    severity: z.unknown().optional(),
    file: z.unknown().optional(),
    line: z.unknown().optional(),
    body: z.string().optional(),
    message: z.string().optional(),
    description: z.string().optional(),
  })
  .transform((value) => {
    const body = value.body ?? value.message ?? value.description ?? value.title ?? "";
    const title = value.title ?? firstLine(body) ?? "Finding";
    return OpenCodeReviewFindingSchema.parse({
      title,
      severity: value.severity,
      file: value.file,
      line: value.line,
      body,
    });
  });

export const OpenCodeReviewSchema = z.object({
  summary: z.string().optional(),
  findings: z.array(LooseFindingSchema).default([]),
});
export type OpenCodeReview = z.infer<typeof OpenCodeReviewSchema>;

export interface ParsedReview {
  summary: string | undefined;
  findings: OpenCodeReviewFinding[];
}

/**
 * JSON Schema handed to `format:{type:"json_schema"}` when the caller opts into
 * structured output. Every property is required and `additionalProperties` is
 * false, because OpenAI structured outputs reject anything looser.
 */
export const OPENCODE_REVIEW_FINDINGS_SCHEMA: JsonSchema = {
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

const FENCE = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/gi;

/**
 * Extract findings from a review's final message.
 *
 * Accepts, in order: a value already parsed by the harness
 * (`AssistantMessage.structured`), a fenced ```json block (the last one wins,
 * because models often show an example first), the whole message as JSON, or a
 * bare array. Prose returns `undefined` and the caller keeps `final.message`.
 */
export function parseReviewFindings(
  message: string | undefined,
  structured?: unknown,
): ParsedReview | undefined {
  const candidates: unknown[] = [];
  if (structured !== undefined && structured !== null) candidates.push(structured);
  if (typeof message === "string" && message.trim().length > 0) {
    const trimmed = message.trim();
    const blocks: string[] = [];
    FENCE.lastIndex = 0;
    for (let match = FENCE.exec(trimmed); match; match = FENCE.exec(trimmed)) {
      const body = match[1];
      if (body) blocks.push(body);
    }
    for (const block of blocks.reverse()) {
      const parsed = safeJsonParse(block);
      if (parsed !== undefined) candidates.push(parsed);
    }
    const whole = safeJsonParse(trimmed);
    if (whole !== undefined) candidates.push(whole);
  }

  for (const candidate of candidates) {
    const review = coerce(candidate);
    if (review) return review;
  }
  return undefined;
}

function coerce(value: unknown): ParsedReview | undefined {
  if (Array.isArray(value)) {
    const parsed = OpenCodeReviewSchema.safeParse({ findings: value });
    if (!parsed.success) return undefined;
    return { summary: undefined, findings: parsed.data.findings };
  }
  if (typeof value !== "object" || value === null) return undefined;
  const parsed = OpenCodeReviewSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { summary: parsed.data.summary, findings: parsed.data.findings };
}

/** Human description of what a review run should look at. */
export function describeReviewTarget(target: ReviewTarget | undefined): string {
  switch (target?.mode) {
    case "base":
      return `the diff of the current branch against \`${target.ref}\` (\`git diff ${target.ref}...HEAD\`)`;
    case "commit":
      return `the changes introduced by commit \`${target.sha}\` (\`git show ${target.sha}\`)`;
    default:
      return "the uncommitted changes in this worktree (`git status` and `git diff HEAD`)";
  }
}

/**
 * Wrap the caller's instructions in the reviewer contract.
 *
 * The JSON block is requested explicitly because the recorded Codex review run
 * answered in prose when it was not asked for structure (§1.7), and OpenCode
 * behaves the same way.
 */
export function buildReviewPrompt(instructions: string, target: ReviewTarget | undefined): string {
  return [
    "You are reviewing code. Do not modify any file: this run is read-only.",
    `Scope: ${describeReviewTarget(target)}.`,
    "",
    instructions.trim(),
    "",
    "When you are done, end your final message with a single fenced JSON block:",
    "",
    "```json",
    "{",
    '  "summary": "one paragraph",',
    '  "findings": [',
    '    {"title": "…", "severity": "critical|high|medium|low|info",',
    '     "file": "path/relative/to/the/worktree or null", "line": 12,',
    '     "body": "what is wrong and what to do about it"}',
    "  ]",
    "}",
    "```",
    "",
    "Report an empty `findings` array when the change is fine. Do not wrap the",
    "block in any other JSON and do not add commentary after it.",
  ].join("\n");
}

function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function firstLine(text: string): string | undefined {
  const line = text.split("\n")[0]?.trim();
  return line && line.length > 0 ? line.slice(0, 120) : undefined;
}
