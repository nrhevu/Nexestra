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
  statusForBoardColumn,
  type Task,
} from "@nexestra/core";
import { Button, StatusDot, Tag } from "@nexestra/ui-kit";
import { useMemo, useState } from "react";
import { useTasks, useThreads, useUpdateTaskStatus } from "../../lib/api.js";
import { formatUsd, statusTone } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";
import { SurfaceLayout } from "../../shell/SurfaceLayout.js";
import { BoardSidebar } from "./BoardSidebar.js";

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
          <span className="nx-muted">{[...board.values()].flat().length} tasks</span>
          <span className="nx-muted">{formatUsd(totalCost)}</span>
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
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingTask ? (
              <div className="task-card task-card--overlay">
                <TaskCardBody task={draggingTask} />
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

function Column({
  column,
  tasks,
  selectedTaskId,
  onSelect,
  draggingId,
}: {
  column: BoardColumn;
  tasks: readonly Task[];
  selectedTaskId: string | null;
  onSelect: (id: string) => void;
  draggingId: string | null;
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
}: {
  task: Task;
  selected: boolean;
  dragging: boolean;
  onSelect: (id: string) => void;
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
      <TaskCardBody task={task} />
    </button>
  );
}

function TaskCardBody({ task }: { task: Task }) {
  return (
    <>
      <span className="task-card__title">{task.title}</span>
      <span className="task-card__meta">
        <StatusDot tone={statusTone(task.status)} label={task.status} />
        {task.assignedHarness ? <Tag tone="info">{task.assignedHarness}</Tag> : null}
        {task.costUSD > 0 ? <Tag>{formatUsd(task.costUSD)}</Tag> : null}
        {task.attempts > 1 ? <Tag tone="warn">{task.attempts} attempts</Tag> : null}
      </span>
      {task.dependsOn.length > 0 ? (
        <span className="task-card__deps">depends on {task.dependsOn.length}</span>
      ) : null}
    </>
  );
}
