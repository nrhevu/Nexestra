import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import { useArtifacts, useRuns, useTasks } from "../../lib/api.js";
import { formatDateTime, formatUsd, statusTone } from "../../lib/format.js";

export function EditorSidebar({ threadId }: { threadId: string }) {
  const runs = useRuns(threadId);
  const tasks = useTasks(threadId);
  const artifacts = useArtifacts(threadId);

  const activeRun =
    (runs.data ?? []).find((run) => run.status === "running") ?? (runs.data ?? []).at(-1);
  const task = (tasks.data ?? []).find((item) => item.id === activeRun?.taskId);

  const allTasks = tasks.data ?? [];
  const doneCount = allTasks.filter((item) => item.status === "done").length;
  const progress = allTasks.length === 0 ? 0 : Math.round((doneCount / allTasks.length) * 100);

  return (
    <>
      <section className="sidebar__section">
        <div className="sidebar__section-title">Active agent</div>
        {activeRun ? (
          <div className="kv">
            <span className="kv__k">harness</span>
            <span className="kv__v">
              <Tag tone="info">{activeRun.harness}</Tag>
            </span>
            <span className="kv__k">kind</span>
            <span className="kv__v">{activeRun.kind}</span>
            <span className="kv__k">session</span>
            <span className="kv__v">{activeRun.sessionRef ?? "—"}</span>
            <span className="kv__k">started</span>
            <span className="kv__v">{formatDateTime(activeRun.startedAt)}</span>
            <span className="kv__k">tokens</span>
            <span className="kv__v">
              {activeRun.usage.inputTokens.toLocaleString()} in /{" "}
              {activeRun.usage.outputTokens.toLocaleString()} out
            </span>
            <span className="kv__k">cost</span>
            <span className="kv__v">{formatUsd(activeRun.usage.costUSD)}</span>
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
            <StatusDot tone={statusTone(task.status)} label={task.status} />
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
          {doneCount} of {allTasks.length} tasks done
        </div>
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Artifacts</div>
        <ul className="sidebar__list">
          {(artifacts.data ?? []).map((artifact) => (
            <li key={artifact.id}>
              <span className="sidebar__bullet">@</span>
              <span>
                {artifact.title} <Tag>{artifact.kind}</Tag>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Button tone="primary" title="Not wired up in M0">
        View changes
      </Button>
    </>
  );
}
