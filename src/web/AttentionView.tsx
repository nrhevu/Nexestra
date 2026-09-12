import { ArrowRight, Check, CircleAlert } from "lucide-react";
import type { AttentionItem } from "../shared/contracts.js";
import "./attention.css";

const reasons: Record<AttentionItem["kind"], string> = {
  approval: "Approval requested",
  input: "Answer needed",
  task_blocked: "Task blocked",
  task_failed: "Worker failed",
  task_interrupted: "Worker interrupted",
};

export function AttentionView({
  items,
  onThread,
  onTask,
  onRun,
  onSnooze,
  onDismiss,
}: {
  items: AttentionItem[];
  onThread: (id: string) => void;
  onTask: (id: string) => void;
  onRun?: (threadId: string, runId: string) => void;
  onSnooze?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  return (
    <div className="surface-view attention-view">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h1>Needs attention</h1>
          <p className="subtitle">Review pending decisions and work that needs your help.</p>
        </div>
        <span className="attention-total">{items.length} pending</span>
      </header>
      {items.length === 0 ? (
        <div className="empty-state">
          <span>
            <Check size={25} />
          </span>
          <h2>Nothing needs your attention</h2>
          <p>Pending approvals, questions, and blocked or failed tasks will appear here.</p>
        </div>
      ) : (
        <ul className="attention-list" aria-label="Items needing attention">
          {items.map((item) => (
            <li className="attention-item" key={item.id}>
              <CircleAlert className="attention-icon" size={19} aria-hidden="true" />
              <div className="attention-content">
                <span className="attention-reason">{reasons[item.kind]}</span>
                <h2>{item.title}</h2>
                <p>{item.detail}</p>
              </div>
              {item.taskId ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onTask(item.taskId as string)}
                  aria-label={`Inspect task: ${item.title}`}
                >
                  Inspect task <ArrowRight size={15} />
                </button>
              ) : item.threadId && item.runId && onRun ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onRun(item.threadId as string, item.runId as string)}
                  aria-label={`Open run: ${item.title}`}
                >
                  Open run <ArrowRight size={15} />
                </button>
              ) : item.threadId ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onThread(item.threadId as string)}
                  aria-label={`Open thread: ${item.title}`}
                >
                  Open thread <ArrowRight size={15} />
                </button>
              ) : null}
              <div className="attention-actions">
                {onSnooze && (
                  <button type="button" className="ghost-button" onClick={() => onSnooze(item.id)}>
                    Snooze 1h
                  </button>
                )}
                {onDismiss && (
                  <button type="button" className="ghost-button" onClick={() => onDismiss(item.id)}>
                    Dismiss
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
