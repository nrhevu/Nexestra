import { type HarnessId, type TaskStatus, TaskStatusSchema } from "@nexestra/core";
import { Button, Select, StatusDot, Tag, TextInput } from "@nexestra/ui-kit";
import { useEffect, useState } from "react";
import { useSpec, useTasks, useUpdateTask } from "../../lib/api.js";
import { formatUsd } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";

const HARNESS_OPTIONS = [
  { value: "codex", label: "codex" },
  { value: "opencode", label: "opencode" },
  { value: "acp", label: "acp (not available)" },
];

const STATUS_OPTIONS = TaskStatusSchema.options.map((status) => ({
  value: status,
  label: status,
}));

export function BoardSidebar({ threadId }: { threadId: string }) {
  const tasks = useTasks(threadId);
  const spec = useSpec(threadId);
  const updateTask = useUpdateTask(threadId);
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);

  const rows = tasks.data ?? [];
  const task = rows.find((item) => item.id === selectedTaskId) ?? rows[0];

  // Local draft so typing is smooth; the title is saved on blur or Enter.
  const [title, setTitle] = useState(task?.title ?? "");
  useEffect(() => setTitle(task?.title ?? ""), [task?.title]);

  if (!task) return <div className="nx-muted">Select a task to see its details.</div>;

  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === task.title) {
      setTitle(task.title);
      return;
    }
    updateTask.mutate({ taskId: task.id, patch: { title: next } });
  };

  const status: TaskStatus = task.status;
  const criteria = (spec.data?.acceptanceCriteria ?? []).filter((criterion) =>
    task.acceptanceCriteriaIds.includes(criterion.id),
  );

  return (
    <>
      <TextInput
        id="task-title"
        label="Title"
        key={`title-${task.id}`}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={saveTitle}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setTitle(task.title);
        }}
      />

      <Select
        id="task-harness"
        label="Assigned agent"
        value={task.assignedHarness ?? "codex"}
        options={HARNESS_OPTIONS}
        onChange={(event) =>
          updateTask.mutate({
            taskId: task.id,
            patch: { assignedHarness: event.target.value as HarnessId },
          })
        }
      />

      <Select
        id="task-status"
        label="Status"
        value={status}
        options={STATUS_OPTIONS}
        onChange={(event) =>
          updateTask.mutate({
            taskId: task.id,
            patch: { status: event.target.value as TaskStatus },
          })
        }
      />

      {updateTask.isError ? <div className="form-error">{updateTask.error.message}</div> : null}

      <section className="sidebar__section">
        <div className="sidebar__section-title">Summary</div>
        <div className="kv">
          <span className="kv__k">status</span>
          <span className="kv__v">
            <StatusDot tone={status === "done" ? "done" : "idle"} label={status} />
          </span>
          <span className="kv__k">attempts</span>
          <span className="kv__v">
            {task.attempts} / {task.maxAttempts}
          </span>
          <span className="kv__k">cost</span>
          <span className="kv__v">{formatUsd(task.costUSD)}</span>
          <span className="kv__k">model</span>
          <span className="kv__v">{task.harnessConfig.model ?? "—"}</span>
          <span className="kv__k">sandbox</span>
          <span className="kv__v">{task.harnessConfig.sandbox}</span>
          <span className="kv__k">branch</span>
          <span className="kv__v">{task.harnessConfig.branch ?? "—"}</span>
        </div>
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">References</div>
        <ul className="sidebar__list">
          {task.dependsOn.length === 0 ? <li className="nx-muted">no dependencies</li> : null}
          {task.dependsOn.map((dependency) => {
            const upstream = rows.find((item) => item.id === dependency);
            return (
              <li key={dependency}>
                <span className="sidebar__bullet">↑</span>
                <span>{upstream?.title ?? dependency}</span>
              </li>
            );
          })}
          {task.harnessConfig.worktreePath ? (
            <li>
              <span className="sidebar__bullet">/</span>
              <span className="nx-muted">{task.harnessConfig.worktreePath}</span>
            </li>
          ) : null}
        </ul>
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Acceptance criteria</div>
        {criteria.length === 0 ? (
          <div className="nx-muted">none linked to this task</div>
        ) : (
          <ul className="sidebar__list">
            {criteria.map((criterion) => (
              <li key={criterion.id}>
                <span className="sidebar__bullet">{criterion.satisfied ? "[x]" : "[ ]"}</span>
                <span>
                  {criterion.text}
                  <br />
                  <Tag tone={criterion.satisfied ? "accent" : "default"}>
                    {criterion.verification.kind}
                  </Tag>{" "}
                  <span className="nx-muted">
                    {criterion.verification.kind === "manual_review"
                      ? criterion.verification.instructions
                      : criterion.verification.command}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="row">
        <Button tone="primary" title="Dispatching a run lands with the orchestrator in M4" disabled>
          Dispatch
        </Button>
        <Button title="Run details land with the orchestrator in M4" disabled>
          View run
        </Button>
      </div>
    </>
  );
}
