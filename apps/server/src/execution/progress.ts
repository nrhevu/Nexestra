/**
 * `OrchestratorEvent` → one renderable line.
 *
 * The loop's notification union is a TypeScript contract inside
 * `@nexestra/orchestrator`; the browser should not have to know it. The server
 * flattens each event into an `OrchestratorProgress` row — a level, a sentence,
 * and the ids it concerns — and appends that as `orchestrator.progress`. The
 * Chat surface renders the sentence; anything that wants more reads `detail`.
 */
import type { OrchestratorProgress } from "@nexestra/core";
import type { OrchestratorEvent } from "@nexestra/orchestrator";

export function toProgress(event: OrchestratorEvent, at: string): OrchestratorProgress {
  const base = { threadId: event.threadId, kind: event.type, at, detail: event };

  switch (event.type) {
    case "thread_started":
      return { ...base, level: "info", message: "Execution started." };

    case "thread_idle":
      return {
        ...base,
        level: event.outcome === "completed" ? "info" : "warn",
        message: `Execution stopped — ${event.outcome.replace(/_/g, " ")}.`,
      };

    case "task_status":
      return {
        ...base,
        level: event.to === "failed" || event.to === "blocked" ? "warn" : "info",
        taskId: event.taskId,
        message: `Task ${event.taskId}: ${event.from} → ${event.to}.`,
      };

    case "run_started":
      return {
        ...base,
        level: "info",
        taskId: event.taskId,
        runId: event.runId,
        message: `${event.harness} ${event.kind} run started (attempt ${event.attempt}).`,
      };

    case "run_ended":
      return {
        ...base,
        level: event.ok ? "info" : "warn",
        taskId: event.taskId,
        runId: event.runId,
        message: event.ok
          ? `${event.kind} run finished.`
          : `${event.kind} run failed${event.error ? `: ${event.error}` : "."}`,
      };

    case "run_retrying":
      return {
        ...base,
        level: "warn",
        taskId: event.taskId,
        message: `Retrying (attempt ${event.attempt}): ${event.reason}`,
      };

    case "review_findings":
      return {
        ...base,
        level: event.blocking > 0 ? "warn" : "info",
        taskId: event.taskId,
        runId: event.runId,
        message:
          event.blocking > 0
            ? `Review found ${event.blocking} blocking finding(s); back to the harness.`
            : `Review passed with ${event.findings.length} note(s).`,
      };

    case "verification_completed": {
      const passed = event.outcomes.filter((outcome) => outcome.passed).length;
      return {
        ...base,
        level: event.passed ? "info" : "warn",
        taskId: event.taskId,
        message: `Verification: ${passed}/${event.outcomes.length} criteria passed.`,
      };
    }

    case "approval_requested":
      return {
        ...base,
        level: "warn",
        ...(event.approval.taskId ? { taskId: event.approval.taskId } : {}),
        ...(event.approval.runId ? { runId: event.approval.runId } : {}),
        message: `Waiting for approval (${event.approval.kind}): ${event.approval.title}`,
      };

    case "approval_resolved":
      return {
        ...base,
        level: event.approval.status === "approved" ? "info" : "warn",
        ...(event.approval.taskId ? { taskId: event.approval.taskId } : {}),
        message: `Approval ${event.approval.status}: ${event.approval.title}`,
      };

    case "replan_requested":
      return {
        ...base,
        level: "warn",
        taskId: event.taskId,
        message: `Asking the Master to replan: ${event.reason}`,
      };

    case "budget_warning":
      return {
        ...base,
        level: "warn",
        message: `Budget: $${event.costUSD.toFixed(2)} of $${event.budgetUSD.toFixed(2)} spent.`,
      };

    case "budget_exceeded":
      return {
        ...base,
        level: "error",
        message: `Budget exhausted ($${event.costUSD.toFixed(2)}); execution paused.`,
      };

    case "merge":
      return {
        ...base,
        level: event.result === "conflict" ? "error" : "info",
        taskId: event.taskId,
        message:
          event.result === "merged"
            ? `Merged ${event.branch} into ${event.into}.`
            : event.result === "pending_approval"
              ? `${event.branch} is verified and waiting for a merge approval.`
              : `Merge of ${event.branch} conflicted${event.detail ? `: ${event.detail}` : "."}`,
      };

    case "error":
      return {
        ...base,
        level: "error",
        ...(event.taskId ? { taskId: event.taskId } : {}),
        message: event.message,
      };

    default: {
      const exhaustive: never = event;
      return {
        threadId: (exhaustive as { threadId: string }).threadId,
        kind: "unknown",
        level: "info",
        message: JSON.stringify(exhaustive),
        at,
        detail: exhaustive,
      };
    }
  }
}

/** Events after which the Task Board wants a fresh `ExecutionStatus`. */
export function affectsStatus(event: OrchestratorEvent): boolean {
  switch (event.type) {
    case "thread_started":
    case "thread_idle":
    case "task_status":
    case "run_started":
    case "run_ended":
    case "approval_requested":
    case "approval_resolved":
    case "budget_warning":
    case "budget_exceeded":
    case "merge":
      return true;
    default:
      return false;
  }
}
