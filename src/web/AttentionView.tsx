import { ArrowRight, Check, CircleAlert, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AttentionAuditEntry, AttentionItem } from "../shared/contracts.js";
import { AttentionAuditEntrySchema } from "../shared/contracts.js";
import { api } from "./api.js";
import "./attention.css";

const reasons: Record<AttentionItem["kind"], string> = {
  approval: "Approval requested",
  input: "Answer needed",
  task_blocked: "Task blocked",
  task_failed: "Worker failed",
  task_interrupted: "Worker interrupted",
};

export function AttentionView({
  workspaceId,
  items,
  onThread,
  onTask,
  onRun,
  onSnooze,
  onDismiss,
  onClear,
}: {
  workspaceId?: string;
  items: AttentionItem[];
  onThread: (id: string) => void;
  onTask: (id: string) => void;
  onRun?: (threadId: string, runId: string) => void;
  onSnooze?: (id: string, durationMinutes?: number) => void;
  onDismiss?: (id: string) => void;
  onClear?: (id: string, kind: AttentionAuditEntry["kind"]) => void;
}) {
  const [audit, setAudit] = useState<AttentionAuditEntry[]>([]);
  const [auditError, setAuditError] = useState("");
  const [auditLoading, setAuditLoading] = useState(false);

  async function loadAudit() {
    if (!workspaceId) return;
    setAuditLoading(true);
    setAuditError("");
    try {
      const response = await api<unknown>(
        `/api/attention/history?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const parsed = AttentionAuditEntrySchema.array().max(200).safeParse(response);
      if (!parsed.success) throw new Error("Attention history response is invalid.");
      setAudit(parsed.data);
    } catch (caught) {
      setAuditError(caught instanceof Error ? caught.message : "Unable to load attention history.");
    } finally {
      setAuditLoading(false);
    }
  }

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
                  <fieldset className="attention-snooze-actions" aria-label="Snooze duration">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onSnooze(item.id)}
                    >
                      Snooze 1h
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onSnooze(item.id, 240)}
                    >
                      4h
                    </button>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onSnooze(item.id, 1440)}
                    >
                      1d
                    </button>
                  </fieldset>
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
      {workspaceId ? (
        <section className="attention-history" aria-label="Recent attention actions">
          <div className="attention-history-header">
            <h2>Recent actions</h2>
            <button
              className="ghost-button"
              type="button"
              onClick={() => void loadAudit()}
              disabled={auditLoading}
            >
              <RefreshCw size={14} aria-hidden="true" />
              {auditLoading ? "Loading…" : "Refresh history"}
            </button>
          </div>
          {auditError ? (
            <p className="attention-history-error" role="alert">
              {auditError}
            </p>
          ) : null}
          {audit.length > 0 ? (
            <ul className="attention-history-list">
              {audit.map((entry) => (
                <li
                  key={`${entry.createdAt}:${entry.attentionId}:${entry.action}:${entry.snoozedUntil ?? ""}`}
                >
                  <span>
                    {entry.action === "snooze"
                      ? "Snoozed"
                      : entry.action === "dismiss"
                        ? "Dismissed"
                        : "Restored"}{" "}
                    · {entry.kind}
                  </span>
                  {onClear && entry.action !== "clear" ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => onClear(entry.attentionId, entry.kind)}
                    >
                      Restore
                    </button>
                  ) : null}
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          ) : auditError ? null : (
            <p className="attention-history-empty">Refresh to load recent actions.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
