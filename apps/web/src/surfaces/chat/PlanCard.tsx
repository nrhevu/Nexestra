import type { Task } from "@nexestra/core";
import { Tag } from "@nexestra/ui-kit";

export interface PlanCardProps {
  readonly title: string;
  /** Persisted tasks, when the plan has already been written to the board. */
  readonly tasks: readonly Task[];
  /** Fallback titles from the message attachment, before the board catches up. */
  readonly taskTitles?: readonly string[];
}

/**
 * The plan preview under a Master message.
 *
 * It renders the real `Task` rows when they exist, so the dependency badges
 * name the task a card is actually waiting on rather than repeating an id the
 * model invented. The titles from the message attachment are the fallback for
 * an older thread whose tasks have since been edited or removed.
 */
export function PlanCard({ title, tasks, taskTitles = [] }: PlanCardProps) {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  return (
    <section className="card" aria-label="Plan preview">
      <div className="card__head">
        <span>Plan</span>
        <span className="card__title">{title}</span>
        <span style={{ marginLeft: "auto" }}>
          <Tag tone="info">{tasks.length || taskTitles.length} tasks</Tag>
        </span>
      </div>
      <div className="card__body">
        {tasks.length === 0 ? (
          <ol className="card__list">
            {taskTitles.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ol>
        ) : (
          <ol className="plan__list">
            {tasks.map((task) => (
              <li className="plan__task" key={task.id}>
                <span className="plan__title">{task.title}</span>
                <span className="plan__meta">
                  {task.assignedHarness ? <Tag tone="info">{task.assignedHarness}</Tag> : null}
                  {task.harnessConfig.model ? <Tag>{task.harnessConfig.model}</Tag> : null}
                  <Tag>{task.harnessConfig.reasoning}</Tag>
                  <Tag tone={task.harnessConfig.sandbox === "read-only" ? "default" : "warn"}>
                    {task.harnessConfig.sandbox}
                  </Tag>
                </span>
                {task.dependsOn.length > 0 ? (
                  <span className="plan__deps">
                    after {task.dependsOn.map((id) => byId.get(id)?.title ?? id).join(", ")}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
