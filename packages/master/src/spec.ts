/**
 * Spec construction and patching.
 *
 * The Master never rewrites the whole Spec: `update_spec` sends a patch, and
 * this module produces the next version. Versions are monotonic, so the UI can
 * show a history and an approval can name the exact version it approved.
 */
import type { AcceptanceCriterion, Decision, OpenQuestion, Spec } from "@nexestra/core";
import type { AskUserQuestion, SpecPatch } from "./tools/schemas.js";

export interface SpecIdentity {
  readonly specId: string;
  readonly threadId: string;
  readonly workspaceId: string;
}

/** An empty version-1 Spec, created the first time the Master writes anything. */
export function createEmptySpec(identity: SpecIdentity, now: string): Spec {
  return {
    id: identity.specId,
    workspaceId: identity.workspaceId,
    threadId: identity.threadId,
    createdAt: now,
    updatedAt: now,
    version: 1,
    goal: "",
    scope: { in: [], out: [] },
    constraints: [],
    expectedOutcome: "",
    acceptanceCriteria: [],
    openQuestions: [],
    decisions: [],
    frozen: false,
  };
}

function upsertCriteria(
  current: readonly AcceptanceCriterion[],
  patch: SpecPatch,
): AcceptanceCriterion[] {
  const removed = new Set(patch.removeAcceptanceCriterionIds ?? []);
  const next = current.filter((criterion) => !removed.has(criterion.id)).map((c) => ({ ...c }));
  for (const incoming of patch.acceptanceCriteria ?? []) {
    if (removed.has(incoming.id)) continue;
    const index = next.findIndex((criterion) => criterion.id === incoming.id);
    if (index >= 0) {
      const existing = next[index];
      if (!existing) continue;
      next[index] = { ...existing, text: incoming.text, verification: incoming.verification };
    } else {
      next.push({
        id: incoming.id,
        text: incoming.text,
        verification: incoming.verification,
        satisfied: false,
      });
    }
  }
  return next;
}

function upsertQuestions(
  current: readonly OpenQuestion[],
  patch: SpecPatch,
  now: string,
): OpenQuestion[] {
  const next = current.map((question) => ({ ...question }));
  for (const incoming of patch.openQuestions ?? []) {
    const index = next.findIndex((question) => question.id === incoming.id);
    const options = incoming.options ?? [];
    if (index >= 0) {
      const existing = next[index];
      if (!existing) continue;
      next[index] = { ...existing, question: incoming.question, options };
    } else {
      next.push({ id: incoming.id, question: incoming.question, options });
    }
  }
  for (const answered of patch.answeredQuestions ?? []) {
    const index = next.findIndex((question) => question.id === answered.id);
    if (index < 0) continue;
    const existing = next[index];
    if (!existing) continue;
    next[index] = { ...existing, answer: answered.answer, answeredAt: now };
  }
  return next;
}

function upsertDecisions(current: readonly Decision[], patch: SpecPatch, now: string): Decision[] {
  const next = current.map((decision) => ({ ...decision }));
  for (const incoming of patch.decisions ?? []) {
    const index = next.findIndex((decision) => decision.id === incoming.id);
    const decision: Decision = {
      id: incoming.id,
      text: incoming.text,
      rationale: incoming.rationale ?? "",
      decidedAt: now,
    };
    if (index >= 0) next[index] = decision;
    else next.push(decision);
  }
  return next;
}

/** Produce the next Spec version from a patch. Never mutates `current`. */
export function applySpecPatch(current: Spec, patch: SpecPatch, now: string): Spec {
  return {
    ...current,
    updatedAt: now,
    version: current.version + 1,
    goal: patch.goal ?? current.goal,
    scope: {
      in: patch.scope?.in ?? current.scope.in,
      out: patch.scope?.out ?? current.scope.out,
    },
    constraints: patch.constraints ?? current.constraints,
    expectedOutcome: patch.expectedOutcome ?? current.expectedOutcome,
    acceptanceCriteria: upsertCriteria(current.acceptanceCriteria, patch),
    openQuestions: upsertQuestions(current.openQuestions, patch, now),
    decisions: upsertDecisions(current.decisions, patch, now),
  };
}

/** Record questions asked through `ask_user` as open questions on the Spec. */
export function addAskedQuestions(
  current: Spec,
  questions: readonly AskUserQuestion[],
  now: string,
): Spec {
  return applySpecPatch(
    current,
    {
      openQuestions: questions.map((question) => ({
        id: question.id,
        question: question.text,
        ...(question.options && question.options.length > 0 ? { options: question.options } : {}),
      })),
    },
    now,
  );
}

/** Record the user's answers, which is what unblocks `spec_frozen`. */
export function answerQuestions(
  current: Spec,
  answers: readonly { readonly id: string; readonly answer: string }[],
  now: string,
): Spec {
  return applySpecPatch(current, { answeredQuestions: [...answers] }, now);
}

export function unansweredQuestions(spec: Spec | null): readonly OpenQuestion[] {
  if (!spec) return [];
  return spec.openQuestions.filter((question) => question.answer === undefined);
}

export function unverifiedCriteria(spec: Spec | null): readonly AcceptanceCriterion[] {
  if (!spec) return [];
  return spec.acceptanceCriteria.filter((criterion) => criterion.evidenceArtifactId === undefined);
}

/** Human-readable Spec digest injected into the prompt on every turn. */
export function renderSpec(spec: Spec | null): string {
  if (!spec) return "No spec drafted yet.";
  const lines: string[] = [
    `version: ${spec.version}${spec.frozen ? " (frozen)" : ""}`,
    `goal: ${spec.goal || "(empty)"}`,
    `expected outcome: ${spec.expectedOutcome || "(empty)"}`,
    `scope.in: ${spec.scope.in.length > 0 ? spec.scope.in.join("; ") : "(empty)"}`,
    `scope.out: ${spec.scope.out.length > 0 ? spec.scope.out.join("; ") : "(empty)"}`,
    `constraints: ${spec.constraints.length > 0 ? spec.constraints.join("; ") : "(empty)"}`,
  ];
  lines.push("acceptance criteria:");
  if (spec.acceptanceCriteria.length === 0) lines.push("  (none)");
  for (const criterion of spec.acceptanceCriteria) {
    const evidence = criterion.evidenceArtifactId
      ? ` evidence=${criterion.evidenceArtifactId}`
      : "";
    lines.push(
      `  - [${criterion.id}] ${criterion.text} (verify: ${criterion.verification.kind})${evidence}`,
    );
  }
  lines.push("open questions:");
  const open = unansweredQuestions(spec);
  if (open.length === 0) lines.push("  (none)");
  for (const question of open) lines.push(`  - [${question.id}] ${question.question}`);
  if (spec.decisions.length > 0) {
    lines.push("decisions:");
    for (const decision of spec.decisions) lines.push(`  - [${decision.id}] ${decision.text}`);
  }
  return lines.join("\n");
}
