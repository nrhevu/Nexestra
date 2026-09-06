import { LoaderCircle, Play } from "lucide-react";
import { useState } from "react";
import type { BootstrapData, Task, WorkAssignment } from "../../shared/contracts.js";
import { api } from "../api.js";

export function TaskLaunch({
  task,
  data,
  assignment,
  onStarted,
}: {
  task: Task;
  data: BootstrapData;
  assignment?: WorkAssignment;
  onStarted: () => Promise<void>;
}) {
  const workers = data.agents.filter(
    (agent) => agent.kind === "worker" && agent.enabled && !agent.archived,
  );
  const repositories = data.knowledge.filter(
    (item) => item.kind === "repository" && item.status === "ready",
  );
  const [workerHandle, setWorkerHandle] = useState(
    workers.find((agent) => agent.id === task.assigneeId && agent.readiness === "ready")?.handle ??
      workers.find((agent) => agent.readiness === "ready")?.handle ??
      "",
  );
  const [repositoryHandle, setRepositoryHandle] = useState(
    repositories.find((item) => item.id === assignment?.repositoryId)?.handle ??
      (task.kind === "code" ? (repositories[0]?.handle ?? "") : ""),
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  if (task.status !== "todo" || assignment?.status === "queued" || assignment?.status === "running")
    return null;
  const missing = !task.threadId
    ? "Link this task to a conversation first."
    : (task.acceptanceCriteria?.length ?? 0) === 0
      ? "Add an acceptance criterion before assigning this task."
      : !workers.some((agent) => agent.readiness === "ready")
        ? "Set up an available Worker in Agent management."
        : task.kind === "code" && !repositoryHandle
          ? "Code tasks need a ready repository from Knowledge."
          : undefined;
  return (
    <section className="task-review task-launch" aria-label="Assign task">
      <h3>{assignment ? "Start a new attempt" : "Assign this task"}</h3>
      <p>Choose a Worker to produce the result. Its submission will return here for review.</p>
      <div className="task-launch-options">
        <label>
          Worker
          <select
            aria-label="Task Worker"
            value={workerHandle}
            disabled={starting}
            onChange={(event) => setWorkerHandle(event.target.value)}
          >
            <option value="">Choose a Worker</option>
            {workers.map((agent) => (
              <option key={agent.id} value={agent.handle} disabled={agent.readiness !== "ready"}>
                @{agent.handle}
                {agent.readiness !== "ready" ? ` — ${agent.readinessLabel}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Workspace
          <select
            aria-label="Task workspace"
            value={repositoryHandle}
            disabled={starting}
            onChange={(event) => setRepositoryHandle(event.target.value)}
          >
            {task.kind !== "code" && <option value="">New directory · no Git required</option>}
            {task.kind === "code" && <option value="">Choose a repository</option>}
            {repositories.map((item) => (
              <option key={item.id} value={item.handle}>
                #{item.handle} · isolated Git worktree
              </option>
            ))}
          </select>
        </label>
      </div>
      {missing && <p>{missing} Use Edit to update task requirements.</p>}
      <small>
        Starting records your @{workerHandle || "Worker"} request in the linked conversation.
      </small>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="review-actions">
        <button
          type="button"
          className="primary-button"
          disabled={starting || Boolean(missing) || !workerHandle}
          onClick={async () => {
            setStarting(true);
            setError(undefined);
            try {
              await api(`/api/tasks/${encodeURIComponent(task.id)}/delegate`, {
                method: "POST",
                body: JSON.stringify({
                  workerHandle,
                  ...(repositoryHandle ? { repositoryHandle } : {}),
                  expectedRevision: task.revision,
                }),
              });
              await onStarted();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : "Could not start the Worker.");
            } finally {
              setStarting(false);
            }
          }}
        >
          {starting ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{" "}
          {starting ? "Starting…" : "Start Worker"}
        </button>
      </div>
    </section>
  );
}
