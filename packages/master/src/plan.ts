/**
 * Plan proposals: what `propose_plan` / `replan` produce, and the validation
 * every proposal has to survive before the session accepts it.
 *
 * The rules come from PLAN.md §4.1 and §3: the graph is a DAG, every task
 * points at at least one acceptance criterion of the frozen spec, and every
 * task carries a complete harness configuration so the orchestrator never has
 * to guess how to run it.
 */
import {
  findPlanCycle,
  type HarnessConfig,
  type HarnessId,
  type PlanEdge,
  type Spec,
} from "@nexestra/core";
import type { PlanTaskInput, ProposePlanInput, ReplanInput } from "./tools/schemas.js";

export interface MasterPlanTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
  readonly acceptanceCriteriaIds: readonly string[];
  readonly harness: HarnessId;
  readonly harnessConfig: HarnessConfig;
}

export interface MasterPlanProposal {
  readonly version: number;
  readonly summary: string;
  readonly tasks: readonly MasterPlanTask[];
  readonly edges: readonly PlanEdge[];
}

export interface PlanValidationIssue {
  readonly code:
    | "unknown_dependency"
    | "self_dependency"
    | "duplicate_task_id"
    | "cycle"
    | "unknown_criterion"
    | "criterion_uncovered"
    | "missing_harness_config";
  readonly message: string;
  readonly taskId?: string;
}

export type PlanValidation =
  | { readonly ok: true; readonly plan: MasterPlanProposal }
  | { readonly ok: false; readonly issues: readonly PlanValidationIssue[] };

const DEFAULT_TIMEOUT_MS = 900_000;

function toTask(input: PlanTaskInput): MasterPlanTask {
  const config: HarnessConfig = {
    reasoning: input.harnessConfig.reasoning,
    sandbox: input.harnessConfig.sandbox,
    tools: input.harnessConfig.tools ?? [],
    skills: input.harnessConfig.skills ?? [],
    mcpServers: [],
    timeoutMs: input.harnessConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(input.harnessConfig.model === undefined ? {} : { model: input.harnessConfig.model }),
    ...(input.harnessConfig.budgetUSD === undefined
      ? {}
      : { budgetUSD: input.harnessConfig.budgetUSD }),
  };
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    dependsOn: [...input.dependsOn],
    acceptanceCriteriaIds: [...input.acceptanceCriteriaIds],
    harness: input.harness,
    harnessConfig: config,
  };
}

function edgesOf(tasks: readonly MasterPlanTask[]): PlanEdge[] {
  const edges: PlanEdge[] = [];
  for (const task of tasks) {
    for (const from of task.dependsOn) edges.push({ from, to: task.id });
  }
  return edges;
}

/**
 * Validate a set of tasks against the frozen spec.
 *
 * `requireFullCriterionCoverage` is on for a fresh `propose_plan` (every
 * acceptance criterion must be somebody's job) and off for `replan`, where a
 * partial amendment is legitimate as long as the merged plan still covers
 * everything — the caller re-validates the merged result.
 */
export function validatePlanTasks(
  tasks: readonly MasterPlanTask[],
  spec: Spec,
  options: { readonly requireFullCriterionCoverage: boolean },
): readonly PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      issues.push({
        code: "duplicate_task_id",
        message: `duplicate task id \`${task.id}\``,
        taskId: task.id,
      });
    }
    ids.add(task.id);
  }

  const criterionIds = new Set(spec.acceptanceCriteria.map((criterion) => criterion.id));
  const covered = new Set<string>();

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        issues.push({
          code: "self_dependency",
          message: `task \`${task.id}\` depends on itself`,
          taskId: task.id,
        });
      } else if (!ids.has(dependency)) {
        issues.push({
          code: "unknown_dependency",
          message: `task \`${task.id}\` depends on unknown task \`${dependency}\``,
          taskId: task.id,
        });
      }
    }
    for (const criterionId of task.acceptanceCriteriaIds) {
      if (!criterionIds.has(criterionId)) {
        issues.push({
          code: "unknown_criterion",
          message: `task \`${task.id}\` references unknown acceptance criterion \`${criterionId}\``,
          taskId: task.id,
        });
      } else {
        covered.add(criterionId);
      }
    }
    if (!task.harnessConfig.reasoning || !task.harnessConfig.sandbox) {
      issues.push({
        code: "missing_harness_config",
        message: `task \`${task.id}\` is missing harness reasoning/sandbox`,
        taskId: task.id,
      });
    }
  }

  const cycle = findPlanCycle(
    tasks.map((task) => task.id),
    edgesOf(tasks),
  );
  if (cycle.length > 0) {
    issues.push({ code: "cycle", message: `dependency cycle: ${cycle.join(" → ")}` });
  }

  if (options.requireFullCriterionCoverage) {
    for (const criterionId of criterionIds) {
      if (!covered.has(criterionId)) {
        issues.push({
          code: "criterion_uncovered",
          message: `acceptance criterion \`${criterionId}\` is not covered by any task`,
        });
      }
    }
  }

  return issues;
}

/** Build and validate a fresh plan proposal. */
export function buildPlanProposal(
  input: ProposePlanInput,
  spec: Spec,
  version: number,
): PlanValidation {
  const tasks = input.tasks.map(toTask);
  const issues = validatePlanTasks(tasks, spec, { requireFullCriterionCoverage: true });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: { version, summary: input.summary, tasks, edges: edgesOf(tasks) },
  };
}

/** Apply a `replan` patch to the current plan and re-validate the result. */
export function applyReplan(
  current: MasterPlanProposal,
  input: ReplanInput,
  spec: Spec,
): PlanValidation {
  const removed = new Set(input.removeTaskIds ?? []);
  const replacements = new Map((input.updateTasks ?? []).map((task) => [task.id, toTask(task)]));

  const tasks: MasterPlanTask[] = [];
  for (const task of current.tasks) {
    if (removed.has(task.id)) continue;
    tasks.push(replacements.get(task.id) ?? task);
  }
  for (const [id, task] of replacements) {
    if (!tasks.some((existing) => existing.id === id)) tasks.push(task);
  }
  for (const task of input.addTasks ?? []) {
    const built = toTask(task);
    if (!tasks.some((existing) => existing.id === built.id)) tasks.push(built);
  }

  const issues = validatePlanTasks(tasks, spec, { requireFullCriterionCoverage: true });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: {
      version: current.version + 1,
      summary: `${current.summary}\n\nReplan: ${input.reason}`,
      tasks,
      edges: edgesOf(tasks),
    },
  };
}
