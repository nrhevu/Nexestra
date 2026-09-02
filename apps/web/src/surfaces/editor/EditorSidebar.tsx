import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import { useArtifacts, useRunControl, useSpec, useTasks } from "../../lib/api.js";
import { formatDateTime, formatUsd, statusTone } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";
import { useActiveRun } from "./useActiveRun.js";

/**
 * Who is working, on what, and how far along.
 *
 * "Progress" is deliberately measured in **acceptance criteria satisfied**, not
 * in tasks done: a plan can be finished and still not have proved anything, and
 * the criteria are the only thing that decides whether the thread is done
 * (PLAN.md §4.1). Tasks are shown too, one line below, because they are what
 * the board is about.
 */
export function EditorSidebar({ threadId }: { threadId: string }) {
  const { run } = useActiveRun(threadId);
  const tasks = useTasks(threadId);
  const spec = useSpec(threadId);
  const artifacts = useArtifacts(threadId);
  const control = useRunControl(threadId);
  const setDiffMode = useUiStore((state) => state.setDiffMode);
  const diffMode = useUiStore((state) => state.diffMode);

  const task = (tasks.data ?? []).find((item) => item.id === run?.taskId);
  const allTasks = tasks.data ?? [];
  const tasksDone = allTasks.filter((item) => item.status === "done").length;

  const criteria = spec.data?.acceptanceCriteria ?? [];
  const satisfied = criteria.filter((criterion) => criterion.satisfied).length;
  const progress = criteria.length === 0 ? 0 : Math.round((satisfied / criteria.length) * 100);

  const runArtifacts = (artifacts.data ?? []).filter(
    (artifact) => !run || artifact.runId === run.id || artifact.taskId === run.taskId,
  );

  return (
    <>
      <section className="sidebar__section">
        <div className="sidebar__section-title">Active agent</div>
        {run ? (
          <div className="kv">
            <span className="kv__k">harness</span>
            <span className="kv__v">
              <Tag tone="info">{run.harness}</Tag>
            </span>
            <span className="kv__k">model</span>
            <span className="kv__v">{task?.harnessConfig.model ?? "default"}</span>
            <span className="kv__k">kind</span>
            <span className="kv__v">{run.kind}</span>
            <span className="kv__k">status</span>
            <span className="kv__v">
              <StatusDot
                tone={
                  run.status === "running"
                    ? "running"
                    : run.status === "succeeded"
                      ? "done"
                      : run.status === "failed"
                        ? "error"
                        : "idle"
                }
                label={run.status}
              />
            </span>
            <span className="kv__k">session</span>
            <span className="kv__v">{run.sessionRef ?? "—"}</span>
            <span className="kv__k">started</span>
            <span className="kv__v">{formatDateTime(run.startedAt)}</span>
            <span className="kv__k">tokens</span>
            <span className="kv__v">
              {run.usage.inputTokens.toLocaleString()} in /{" "}
              {run.usage.outputTokens.toLocaleString()} out
            </span>
            <span className="kv__k">cost</span>
            <span className="kv__v">{formatUsd(run.usage.costUSD)}</span>
          </div>
        ) : (
          <div className="nx-muted">no run in flight</div>
        )}
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Current task</div>
        {task ? (
          <>
            <div style={{ color: "var(--nx-fg)", marginBottom: 4 }}>{task.title}</div>
            <StatusDot tone={statusTone(task.status)} label={task.status} />{" "}
            <span className="nx-muted">
              attempt {task.attempts}/{task.maxAttempts} · {formatUsd(task.costUSD)}
            </span>
          </>
        ) : (
          <div className="nx-muted">—</div>
        )}
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Progress — {progress}%</div>
        <div className="progress">
          <div className="progress__fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="nx-muted" style={{ marginTop: 4 }}>
          {satisfied} of {criteria.length} criteria satisfied
          <br />
          {tasksDone} of {allTasks.length} tasks done
        </div>
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Artifacts</div>
        {runArtifacts.length === 0 ? (
          <div className="nx-muted">none recorded yet</div>
        ) : (
          <ul className="sidebar__list">
            {runArtifacts.map((artifact) => (
              <li key={artifact.id}>
                <span className="sidebar__bullet">@</span>
                <span>
                  {artifact.title} <Tag>{artifact.kind}</Tag>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="row">
        <Button
          tone="primary"
          boxed
          disabled={!run}
          onClick={() => setDiffMode(!diffMode)}
          title="Show this worktree against the branch it was cut from"
        >
          {diffMode ? "Hide changes" : "View changes"}
        </Button>
        <Button
          tone="danger"
          boxed
          disabled={run?.status !== "running" || control.isPending}
          onClick={() => run && control.mutate({ runId: run.id, body: { action: "cancel" } })}
        >
          Cancel run
        </Button>
      </div>
      {control.isError ? <div className="form-error">{control.error.message}</div> : null}
    </>
  );
}
