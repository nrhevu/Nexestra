import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  type BoardColumn,
  boardColumnForStatus,
  type ExecutionAction,
  type ExecutionStatus,
  statusForBoardColumn,
  type Task,
  type TaskStatus,
} from "@nexestra/core";
import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import { useMemo, useState } from "react";
import {
  useExecutionControl,
  useExecutionStatus,
  useTasks,
  useThreads,
  useUpdateTaskStatus,
} from "../../lib/api.js";
import { formatUsd, phaseTone, statusTone } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { BoardSidebar } from "./BoardSidebar.js";

/** Statuses that mean "a harness or a verification command is on it right now". */
const LIVE_STATUSES: readonly TaskStatus[] = ["running", "verifying"];

const ALWAYS_VISIBLE: readonly BoardColumn[] = ["todo", "in_progress", "done"];
const COLUMN_ORDER: readonly BoardColumn[] = ["todo", "in_progress", "review", "blocked", "done"];
const COLUMN_LABEL: Record<BoardColumn, string> = {
  todo: "TODO",
  in_progress: "IN PROGRESS",
  review: "REVIEW",
  blocked: "BLOCKED",
  done: "DONE",
};

export function BoardSurface({ workspaceId, threadId }: { workspaceId: string; threadId: string }) {
  const threads = useThreads(workspaceId);
  const tasks = useTasks(threadId);
  const thread = (threads.data ?? []).find((item) => item.id === threadId);

  const updateTaskStatus = useUpdateTaskStatus(threadId);
  const execution = useExecutionStatus(threadId);
  const control = useExecutionControl(threadId);
  const selectedTaskId = useUiStore((state) => state.selectedTaskId);
  const selectTask = useUiStore((state) => state.selectTask);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const board = useMemo(() => {
    const grouped = new Map<BoardColumn, Task[]>();
    for (const column of COLUMN_ORDER) grouped.set(column, []);
    for (const task of tasks.data ?? []) grouped.get(boardColumnForStatus(task.status))?.push(task);
    for (const list of grouped.values()) list.sort((a, b) => a.order - b.order);
    return grouped;
  }, [tasks.data]);

  // Dependency badges name the blocking task, not its id: an id the model
  // invented ("t2") tells the reader nothing.
  const titles = useMemo(
    () => new Map((tasks.data ?? []).map((task) => [task.id, task.title])),
    [tasks.data],
  );

  const visibleColumns = COLUMN_ORDER.filter(
    (column) => ALWAYS_VISIBLE.includes(column) || (board.get(column)?.length ?? 0) > 0,
  );

  const draggingTask = draggingId
    ? [...board.values()].flat().find((task) => task.id === draggingId)
    : undefined;

  const onDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));
  /** Dropping a card writes the new status through `POST /api/tasks/:id/status`. */
  const onDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const over = event.over?.id;
    if (!over) return;
    const column = COLUMN_ORDER.find((candidate) => candidate === over);
    if (!column) return;

    const taskId = String(event.active.id);
    const status = statusForBoardColumn(column);
    selectTask(taskId);
    const current = (tasks.data ?? []).find((task) => task.id === taskId);
    if (!current || current.status === status) return;
    updateTaskStatus.mutate({ taskId, status });
  };

  const totalCost = [...board.values()].flat().reduce((sum, task) => sum + task.costUSD, 0);

  return (
    <SurfaceLayout
      id="board"
      title={`Task Board — ${thread?.title ?? threadId}`}
      headerRight={
        <>
          {thread ? <Tag tone={phaseTone(thread.phase)}>{thread.phase}</Tag> : null}
          <span className="nx-muted">{[...board.values()].flat().length} tasks</span>
          <span className="nx-muted">{formatUsd(totalCost)}</span>
          <ExecutionControls
            status={execution.data}
            taskCount={[...board.values()].flat().length}
            busy={control.isPending}
            onAction={(action) => control.mutate(action)}
          />
          {control.isError ? <span className="form-error">{control.error.message}</span> : null}
          {updateTaskStatus.isError ? (
            <span className="form-error">{updateTaskStatus.error.message}</span>
          ) : null}
        </>
      }
      main={
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDraggingId(null)}
        >
          <div className="board">
            {tasks.isPending ? <div className="state">loading tasks…</div> : null}
            {visibleColumns.map((column) => (
              <Column
                key={column}
                column={column}
                tasks={board.get(column) ?? []}
                selectedTaskId={selectedTaskId}
                onSelect={selectTask}
                draggingId={draggingId}
                titles={titles}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingTask ? (
              <div className="task-card task-card--overlay">
                <TaskCardBody task={draggingTask} titles={titles} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      }
      sidebarTitle="Task details"
      sidebar={<BoardSidebar threadId={threadId} />}
    />
  );
}

/**
 * `[Start execution]` and friends, driven by the loop's own state rather than
 * by `Thread.phase`.
 *
 * They are the same three verbs the orchestrator exposes — start, pause /
 * resume, cancel — and which of them makes sense is a pure function of
 * `ExecutionStatus.state`, so there is no local "is it running?" flag to drift.
 */
function ExecutionControls({
  status,
  taskCount,
  busy,
  onAction,
}: {
  status: ExecutionStatus | undefined;
  taskCount: number;
  busy: boolean;
  onAction: (action: ExecutionAction) => void;
}) {
  const state = status?.state ?? "idle";
  const running = state === "running";
  const paused = state === "paused";
  const activeRuns = status?.activeRuns.length ?? 0;

  return (
    <span className="board__controls">
      <Tag tone={running ? "info" : paused ? "warn" : "default"}>
        {running && activeRuns > 0 ? `running · ${activeRuns} run(s)` : state}
      </Tag>
      {running ? (
        <Button boxed disabled={busy} onClick={() => onAction("pause")}>
          Pause
        </Button>
      ) : (
        <Button
          tone="primary"
          boxed
          disabled={busy || taskCount === 0 || status?.available === false}
          title={
            status?.available === false
              ? "No harness adapter is available in the server process"
              : taskCount === 0
                ? "The plan has no tasks yet"
                : "Hand the plan to the orchestrator"
          }
          onClick={() => onAction(paused ? "resume" : "start")}
        >
          {paused ? "Resume" : "Start execution"}
        </Button>
      )}
      <Button
        tone="danger"
        boxed
        disabled={busy || (!running && !paused)}
        onClick={() => onAction("cancel")}
      >
        Cancel
      </Button>
    </span>
  );
}

function Column({
  column,
  tasks,
  selectedTaskId,
  onSelect,
  draggingId,
  titles,
}: {
  column: BoardColumn;
  tasks: readonly Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  draggingId: string | null;
  titles: ReadonlyMap<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column });

  return (
    <section className={`column${isOver ? " column--over" : ""}`} ref={setNodeRef}>
      <header className="column__head">
        <span>{COLUMN_LABEL[column]}</span>
        <span className="column__count">{tasks.length}</span>
        {column === "todo" ? (
          <span className="column__actions">
            <Button title="Adding tasks by hand lands with the planner in M3" disabled>
              {" + Add "}
            </Button>
          </span>
        ) : null}
      </header>
      <div className="column__body">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            selected={task.id === selectedTaskId}
            dragging={task.id === draggingId}
            onSelect={onSelect}
            titles={titles}
          />
        ))}
        {tasks.length === 0 ? <div className="nx-muted">— empty —</div> : null}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  selected,
  dragging,
  onSelect,
  titles,
}: {
  task: Task;
  selected: boolean;
  dragging: boolean;
  onSelect: (id: string) => void;
  titles: ReadonlyMap<string, string>;
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: task.id });

  return (
    <button
      type="button"
      ref={setNodeRef}
      className={`task-card${selected ? " task-card--selected" : ""}${
        dragging ? " task-card--dragging" : ""
      }`}
      onClick={() => onSelect(task.id)}
      {...listeners}
      {...attributes}
    >
      <TaskCardBody task={task} titles={titles} />
    </button>
  );
}

function TaskCardBody({ task, titles }: { task: Task; titles: ReadonlyMap<string, string> }) {
  return (
    <>
      <span className="task-card__title">
        {LIVE_STATUSES.includes(task.status) ? (
          <span className="spinner" aria-hidden="true" />
        ) : null}
        {task.title}
      </span>
      <span className="task-card__meta">
        <StatusDot tone={statusTone(task.status)} label={task.status} />
        {task.assignedHarness ? <Tag tone="info">{task.assignedHarness}</Tag> : null}
        {task.harnessConfig.model ? <Tag tone="magenta">{task.harnessConfig.model}</Tag> : null}
        <Tag>{task.harnessConfig.reasoning}</Tag>
        {task.costUSD > 0 ? <Tag>{formatUsd(task.costUSD)}</Tag> : null}
        {task.attempts > 0 ? (
          <Tag tone={task.attempts > 1 ? "warn" : "default"}>
            {task.attempts}/{task.maxAttempts} attempts
          </Tag>
        ) : null}
        {task.mergeState ? (
          <Tag tone={task.mergeState === "merged" ? "accent" : "warn"}>{task.mergeState}</Tag>
        ) : null}
      </span>
      {task.dependsOn.length > 0 ? (
        <span className="task-card__deps">
          ↑ blocked by {task.dependsOn.map((id) => titles.get(id) ?? id).join(", ")}
        </span>
      ) : null}
    </>
  );
}
