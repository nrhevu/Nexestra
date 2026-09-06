import {
  ArrowRight,
  Check,
  Clock3,
  Flag,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BootstrapData, Task } from "../../shared/contracts.js";
import {
  type CreateWorkGoalInput,
  terminalGoalStatuses,
  type WorkGoal,
} from "../../shared/goals.js";
import { api } from "../api.js";
import { Modal } from "../components/Modal.js";
import "./goals.css";

const statusNames: Record<WorkGoal["status"], string> = {
  draft: "Draft",
  active: "Working",
  waiting_review: "Needs your review",
  paused: "Paused",
  blocked: "Needs attention",
  exhausted: "Limit reached",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function Goals({
  data,
  createSequence = 0,
  onChanged,
  onTask,
  onThread,
}: {
  data: BootstrapData;
  createSequence?: number;
  onChanged: () => Promise<unknown>;
  onTask: (task: Task) => void;
  onThread: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState(data.goals);
  const [selectedId, setSelectedId] = useState(data.goals[0]?.id);
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const previousCreate = useRef(createSequence);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  useEffect(() => {
    setCatalog(data.goals);
  }, [data.goals]);
  useEffect(() => {
    if (previousCreate.current !== createSequence) {
      previousCreate.current = createSequence;
      setCreating(true);
    }
  }, [createSequence]);
  const hasActive = catalog.some((goal) => ["active", "waiting_review"].includes(goal.status));
  useEffect(() => {
    if (!hasActive) return;
    let disposed = false;
    let pending = false;
    const timer = window.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const latest = await api<WorkGoal[]>(
          `/api/goals?workspaceId=${encodeURIComponent(data.workspace.id)}`,
        );
        if (
          !disposed &&
          JSON.stringify(latest.map((goal) => [goal.id, goal.revision])) !==
            JSON.stringify(catalogRef.current.map((goal) => [goal.id, goal.revision]))
        ) {
          setCatalog(latest);
          await changedRef.current();
        }
      } catch (caught) {
        if (!disposed) setError(errorMessage(caught));
      } finally {
        pending = false;
      }
    }, 1500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [hasActive, data.workspace.id]);
  const selected = catalog.find((goal) => goal.id === selectedId) ?? catalog[0];
  const control = async (action: "start" | "pause" | "cancel") => {
    if (!selected) return;
    setWorking(true);
    setError(undefined);
    try {
      const goal = await api<WorkGoal>(`/api/goals/${selected.id}/control`, {
        method: "POST",
        body: JSON.stringify({ action, expectedRevision: selected.revision }),
      });
      setCatalog((current) => [goal, ...current.filter((entry) => entry.id !== goal.id)]);
      await onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div className="surface-view goals-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">PURPOSE AND CONTINUITY</p>
          <h1>Goals</h1>
          <p className="subtitle">Keep work moving, with a clear scope and stopping point.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setCreating(true)}>
          <Plus size={16} /> New goal
        </button>
      </header>
      <div className="goals-layout">
        <nav className="goals-catalog" aria-label="Goals">
          {catalog.map((goal) => (
            <button
              type="button"
              key={goal.id}
              aria-pressed={goal.id === selected?.id}
              onClick={() => {
                setSelectedId(goal.id);
                setError(undefined);
              }}
            >
              <Flag size={15} />
              <span>
                <strong>{goal.objective}</strong>
                <small>
                  {statusNames[goal.status]} · {goal.accepted.length}/{goal.steps.length} accepted
                </small>
              </span>
            </button>
          ))}
          {!catalog.length && <p>Your goals will appear here.</p>}
        </nav>
        <section className="goal-detail" aria-label="Goal checkpoint">
          {!selected ? (
            <div className="goal-empty">
              <Flag size={40} />
              <h2>Turn a plan into steady progress</h2>
              <p>
                Choose tasks with clear success criteria. Set an attempt limit and a deadline.
                Nexestra runs one task at a time and waits for your review before continuing.
              </p>
              <button type="button" className="primary-button" onClick={() => setCreating(true)}>
                <Plus size={15} /> Create a goal
              </button>
            </div>
          ) : (
            <>
              <div className="goal-heading">
                <span className={`goal-status ${selected.status}`}>
                  {statusNames[selected.status]}
                </span>
                <h2>{selected.objective}</h2>
                {selected.workBrief && (
                  <p className="goal-brief">
                    Pinned brief: {selected.workBrief.title} · revision{" "}
                    {selected.workBrief.revision}
                  </p>
                )}
                <p>{selected.stopReason}</p>
              </div>
              <div className="goal-budget">
                <div>
                  <strong>
                    {selected.accepted.length} <span>/ {selected.steps.length}</span>
                  </strong>
                  <small>Tasks accepted</small>
                </div>
                <div>
                  <strong>
                    {selected.attemptsUsed} <span>/ {selected.attemptLimit}</span>
                  </strong>
                  <small>Attempts used</small>
                </div>
                <div>
                  <strong>
                    {selected.timeLimitMinutes}
                    <span> min</span>
                  </strong>
                  <small>
                    {selected.deadlineAt
                      ? `Deadline ${new Date(selected.deadlineAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                      : "Time limit from first start"}
                  </small>
                </div>
              </div>
              <div className="goal-controls">
                {!terminalGoalStatuses.has(selected.status) &&
                  (["active", "waiting_review"].includes(selected.status) ? (
                    <button type="button" disabled={working} onClick={() => void control("pause")}>
                      <Pause size={14} /> Pause goal
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={working}
                      onClick={() => void control("start")}
                    >
                      {working ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}
                      {selected.status === "draft" ? "Start goal" : "Resume goal"}
                    </button>
                  ))}
                <button
                  type="button"
                  disabled={working}
                  onClick={async () => {
                    try {
                      await onChanged();
                      setError(undefined);
                    } catch (caught) {
                      setError(errorMessage(caught));
                    }
                  }}
                >
                  <RefreshCw size={14} /> Reload checkpoint
                </button>
                <button type="button" onClick={() => onThread(selected.threadId)}>
                  <ArrowRight size={14} /> Open conversation
                </button>
                {!terminalGoalStatuses.has(selected.status) && (
                  <button type="button" disabled={working} onClick={() => void control("cancel")}>
                    <X size={14} /> Cancel goal
                  </button>
                )}
              </div>
              {error && (
                <p role="alert" className="goal-error">
                  {error}
                </p>
              )}
              <p className="goal-policy">
                <Clock3 size={14} /> The time limit includes pauses and review time. Each submitted
                result waits for your review; requesting changes uses another attempt.
              </p>
              <ol className="goal-steps">
                {selected.steps.map((step, index) => {
                  const task = data.tasks.find((entry) => entry.id === step.taskId);
                  const worker = data.agents.find((entry) => entry.id === step.workerAgentId);
                  const accepted = selected.accepted.some((entry) => entry.taskId === step.taskId);
                  const assignment = data.assignments.find(
                    (entry) =>
                      entry.taskId === step.taskId &&
                      entry.contract?.revision === step.contract.revision,
                  );
                  const review =
                    !accepted && assignment?.status === "completed" && !assignment.review;
                  const running = assignment && ["queued", "running"].includes(assignment.status);
                  return (
                    <li key={step.taskId}>
                      <div className={accepted ? "goal-step-index accepted" : "goal-step-index"}>
                        {accepted ? <Check size={15} /> : index + 1}
                      </div>
                      <div className="goal-step-copy">
                        <h3>{step.contract.title}</h3>
                        <p>
                          {step.contract.kind} · @{worker?.handle ?? "unavailable"} · revision{" "}
                          {step.contract.revision} · {step.contract.acceptanceCriteria.length}{" "}
                          checks
                        </p>
                        <details>
                          <summary>Success criteria</summary>
                          <p className="goal-criteria">
                            {step.contract.acceptanceCriteria
                              .map(
                                (criterion, index) =>
                                  `${index + 1}. ${criterion.behavior}\nCheck: ${criterion.verification}`,
                              )
                              .join("\n\n")}
                          </p>
                        </details>
                      </div>
                      <div className="goal-step-action">
                        <small>
                          {accepted
                            ? "Accepted"
                            : review
                              ? "Needs review"
                              : running
                                ? "Working"
                                : "Pending"}
                        </small>
                        {task && (
                          <button type="button" onClick={() => onTask(task)}>
                            {review ? "Review result" : "Inspect task"}
                            <ArrowRight size={13} />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <details className="goal-history">
                <summary>Checkpoint history · revision {selected.revision}</summary>
                <ol>
                  {selected.events
                    .slice(-12)
                    .reverse()
                    .map((event) => (
                      <li key={event.id}>
                        <time>
                          {new Date(event.at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        <span>{event.detail}</span>
                      </li>
                    ))}
                </ol>
              </details>
            </>
          )}
        </section>
      </div>
      {creating && (
        <NewGoalDialog
          data={data}
          onClose={() => setCreating(false)}
          onCreated={async (goal) => {
            setCatalog((current) => [goal, ...current]);
            setSelectedId(goal.id);
            setCreating(false);
            await onChanged();
          }}
        />
      )}
    </div>
  );
}

function NewGoalDialog({
  data,
  onClose,
  onCreated,
}: {
  data: BootstrapData;
  onClose: () => void;
  onCreated: (goal: WorkGoal) => Promise<void>;
}) {
  const [threadId, setThreadId] = useState(
    data.tasks.find((task) => task.threadId && task.acceptanceCriteria.length)?.threadId ??
      data.threads[0]?.id ??
      "",
  );
  const [objective, setObjective] = useState("");
  const [steps, setSteps] = useState<CreateWorkGoalInput["steps"]>([]);
  const [attemptLimit, setAttemptLimit] = useState(6);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const workers = data.agents.filter(
    (agent) => agent.kind === "worker" && agent.enabled && !agent.archived,
  );
  const repositories = data.knowledge.filter(
    (item) => item.kind === "repository" && item.status === "ready",
  );
  const tasks = data.tasks.filter(
    (task) => task.threadId === threadId && task.acceptanceCriteria.length > 0,
  );
  return (
    <Modal
      title="Create a goal"
      eyebrow="REVIEW THE SCOPE BEFORE STARTING"
      onClose={onClose}
      closeDisabled={busy}
      wide
    >
      <form
        className="goal-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await onCreated(
              await api<WorkGoal>("/api/goals", {
                method: "POST",
                body: JSON.stringify({
                  threadId,
                  objective,
                  steps,
                  attemptLimit,
                  timeLimitMinutes,
                }),
              }),
            );
          } catch (caught) {
            setError(errorMessage(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Desired outcome
          <textarea
            aria-label="Goal outcome"
            rows={2}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            maxLength={2000}
            required
            placeholder="What should be true when these tasks are accepted?"
          />
        </label>
        <label>
          Conversation
          <select
            aria-label="Goal conversation"
            value={threadId}
            onChange={(event) => {
              setThreadId(event.target.value);
              setSteps([]);
            }}
          >
            {data.threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.name}
              </option>
            ))}
          </select>
        </label>
        <div className="goal-form-tasks">
          <p>Select up to 10 tasks in the order they should run.</p>
          {tasks.map((task) => {
            const step = steps.find((entry) => entry.taskId === task.id);
            const change = (patch: Partial<CreateWorkGoalInput["steps"][number]>) =>
              setSteps((current) =>
                current.map((entry) => (entry.taskId === task.id ? { ...entry, ...patch } : entry)),
              );
            return (
              <div key={task.id} className={step ? "selected" : ""}>
                <button
                  type="button"
                  className="goal-task-choice"
                  aria-pressed={Boolean(step)}
                  disabled={!workers.length || (!step && steps.length >= 10)}
                  onClick={() =>
                    setSteps((current) =>
                      step
                        ? current.filter((entry) => entry.taskId !== task.id)
                        : [
                            ...current,
                            {
                              taskId: task.id,
                              expectedRevision: task.revision,
                              workerHandle: workers[0]?.handle ?? "",
                            },
                          ],
                    )
                  }
                >
                  {step ? <Check size={15} /> : <Square size={15} />}
                  <span>
                    {task.title}{" "}
                    <small>
                      {task.kind} · {task.acceptanceCriteria.length} success checks
                      {step ? ` · runs ${steps.indexOf(step) + 1}` : ""}
                    </small>
                  </span>
                </button>
                {step && (
                  <div className="goal-step-config">
                    <label>
                      Worker
                      <select
                        aria-label={`Worker for ${task.title}`}
                        value={step.workerHandle}
                        onChange={(event) => change({ workerHandle: event.target.value })}
                      >
                        {workers.map((worker) => (
                          <option key={worker.id} value={worker.handle}>
                            @{worker.handle}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Environment
                      <select
                        aria-label={`Environment for ${task.title}`}
                        value={step.repositoryHandle ?? ""}
                        onChange={(event) =>
                          change({ repositoryHandle: event.target.value || undefined })
                        }
                      >
                        <option value="">
                          {task.kind === "code" ? "Choose a repository" : "Isolated directory"}
                        </option>
                        {repositories.map((repository) => (
                          <option key={repository.id} value={repository.handle}>
                            #{repository.handle}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            );
          })}
          {!tasks.length && <p>Create tasks with success criteria in this conversation first.</p>}
          {!workers.length && <p>Add an enabled Worker in Agent management first.</p>}
        </div>
        <div className="goal-form-limits">
          <label>
            Maximum attempts
            <input
              aria-label="Maximum attempts"
              type="number"
              min={Math.max(1, steps.length)}
              max={30}
              value={attemptLimit}
              onChange={(event) => setAttemptLimit(Number(event.target.value))}
              required
            />
          </label>
          <label>
            Time limit (minutes)
            <input
              aria-label="Goal time limit"
              type="number"
              min={1}
              max={240}
              value={timeLimitMinutes}
              onChange={(event) => setTimeLimitMinutes(Number(event.target.value))}
              required
            />
          </label>
        </div>
        <p className="goal-form-note">
          Creates a draft. Start it after reviewing the scope. Attempts include retries; time runs
          from the first start, including pauses and time waiting for review. These limits do not
          measure provider token spend.
        </p>
        {error && (
          <p role="alert" className="goal-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !steps.length || !workers.length}
          >
            {busy && <LoaderCircle size={15} className="spin" />}Create draft goal
          </button>
        </div>
      </form>
    </Modal>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not update this goal.";
}
