import type { HarnessId, ReasoningLevel, SandboxLevel, TaskStatus } from "@nexestra/core";
import { ReasoningLevelSchema, SandboxLevelSchema, TaskStatusSchema } from "@nexestra/core";
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

const REASONING_OPTIONS = ReasoningLevelSchema.options.map((level) => ({
  value: level,
  label: level,
}));

const SANDBOX_OPTIONS = SandboxLevelSchema.options.map((level) => ({
  value: level,
  label: level,
}));

/**
 * Surface 2's sidebar: everything about one task, editable.
 *
 * The Master proposes the harness and its configuration; the user overrules it
 * here. Edits go through `PATCH /api/tasks/:id`, which merges into
 * `harnessConfig` rather than replacing it, so changing the model does not
 * silently drop the sandbox the Master chose.
 */
export function BoardSidebar({ threadId }: { threadId: string }) {
  const tasks = useTasks(threadId);
  const spec = useSpec(threadId);
  const updateTask = useUpdateTask(threadId);
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);

  const rows = tasks.data ?? [];
  const task = rows.find((item) => item.id === selectedTaskId) ?? rows[0];

  // Local drafts so typing is smooth; saved on blur or Enter.
  const [title, setTitle] = useState(task?.title ?? "");
  const [model, setModel] = useState(task?.harnessConfig.model ?? "");
  useEffect(() => setTitle(task?.title ?? ""), [task?.title]);
  useEffect(() => setModel(task?.harnessConfig.model ?? ""), [task?.harnessConfig.model]);

  if (!task) return <div className="nx-muted">Select a task to see its details.</div>;

  const saveTitle = () => {
    const next = title.trim();
    if (!next || next === task.title) {
      setTitle(task.title);
      return;
    }
    updateTask.mutate({ taskId: task.id, patch: { title: next } });
  };

  const saveModel = () => {
    const next = model.trim();
    // Clearing the field means "use the workspace default", which the harness
    // config expresses by leaving `model` unset — so revert rather than
    // writing an empty string the adapter would then pass to the CLI.
    if (!next || next === task.harnessConfig.model) {
      setModel(task.harnessConfig.model ?? "");
      return;
    }
    updateTask.mutate({ taskId: task.id, patch: { harnessConfig: { model: next } } });
  };

  const status: TaskStatus = task.status;
  const criteria = (spec.data?.acceptanceCriteria ?? []).filter((criterion) =>
    task.acceptanceCriteriaIds.includes(criterion.id),
  );
  const blockedBy = task.dependsOn.map((id) => ({
    id,
    task: rows.find((item) => item.id === id),
  }));
  const blocking = rows.filter((item) => item.dependsOn.includes(task.id));

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

      <TextInput
        id="task-model"
        label="Model"
        key={`model-${task.id}`}
        value={model}
        placeholder="workspace default"
        onChange={(event) => setModel(event.target.value)}
        onBlur={saveModel}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setModel(task.harnessConfig.model ?? "");
        }}
      />

      <Select
        id="task-reasoning"
        label="Reasoning"
        value={task.harnessConfig.reasoning}
        options={REASONING_OPTIONS}
        onChange={(event) =>
          updateTask.mutate({
            taskId: task.id,
            patch: { harnessConfig: { reasoning: event.target.value as ReasoningLevel } },
          })
        }
      />

      <Select
        id="task-sandbox"
        label="Sandbox"
        value={task.harnessConfig.sandbox}
        options={SANDBOX_OPTIONS}
        onChange={(event) =>
          updateTask.mutate({
            taskId: task.id,
            patch: { harnessConfig: { sandbox: event.target.value as SandboxLevel } },
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
          <span className="kv__k">timeout</span>
          <span className="kv__v">{Math.round(task.harnessConfig.timeoutMs / 60_000)} min</span>
          <span className="kv__k">branch</span>
          <span className="kv__v">{task.harnessConfig.branch ?? "—"}</span>
        </div>
      </section>

      {task.description ? (
        <section className="sidebar__section">
          <div className="sidebar__section-title">Description</div>
          <div className="nx-muted" style={{ whiteSpace: "pre-wrap" }}>
            {task.description}
          </div>
        </section>
      ) : null}

      <section className="sidebar__section">
        <div className="sidebar__section-title">Blocked by</div>
        <ul className="sidebar__list">
          {blockedBy.length === 0 ? <li className="nx-muted">nothing — ready to start</li> : null}
          {blockedBy.map((dependency) => (
            <li key={dependency.id}>
              <span className="sidebar__bullet">↑</span>
              <span>
                {dependency.task?.title ?? dependency.id}{" "}
                {dependency.task ? (
                  <Tag tone={dependency.task.status === "done" ? "accent" : "warn"}>
                    {dependency.task.status}
                  </Tag>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {blocking.length > 0 ? (
        <section className="sidebar__section">
          <div className="sidebar__section-title">Blocks</div>
          <ul className="sidebar__list">
            {blocking.map((downstream) => (
              <li key={downstream.id}>
                <span className="sidebar__bullet">↓</span>
                <span>{downstream.title}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                    {criterion.verification.kind.replace("_", " ")}
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
