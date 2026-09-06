import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { Task, WorkAssignment } from "../../shared/contracts.js";
import { api } from "../api.js";
import "./TaskReview.css";

export function TaskReview({
  task,
  assignment,
  onReviewed,
}: {
  task: Task;
  assignment: WorkAssignment;
  onReviewed: () => Promise<void>;
}) {
  const [observations, setObservations] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const { contract, review } = assignment;
  if (assignment.status !== "completed") return null;
  if (review)
    return (
      <section className="task-review" aria-label="Recorded review">
        <h3>
          {review.outcome === "accepted" ? <Check size={16} /> : <CircleAlert size={16} />}
          {review.outcome === "accepted" ? "Accepted by you" : "Changes requested"}
        </h3>
        <p>{review.notes}</p>
        {review.evidence.map((item) => (
          <div className="review-observation" key={item.criterionIndex}>
            <strong>{contract?.acceptanceCriteria[item.criterionIndex]?.behavior}</strong>
            <p>{item.observation}</p>
          </div>
        ))}
        <small>
          Task revision {review.expectedRevision} · {new Date(review.createdAt).toLocaleString()}
        </small>
      </section>
    );
  if (!contract || contract.revision !== task.revision)
    return (
      <section className="task-review" aria-label="Review unavailable">
        <h3>Requirements have changed</h3>
        <p>
          This result has no matching task contract. Start an assignment with the current
          requirements before accepting a result.
        </p>
      </section>
    );
  const canAccept =
    contract.acceptanceCriteria.length > 0 &&
    contract.acceptanceCriteria.every((_, index) => observations[index]?.trim());
  const submit = async (outcome: "accepted" | "changes_requested") => {
    setSaving(true);
    setError(undefined);
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}/review`, {
        method: "POST",
        body: JSON.stringify({
          assignmentId: assignment.id,
          expectedRevision: task.revision,
          outcome,
          notes: notes.trim(),
          evidence: contract.acceptanceCriteria.flatMap((_, criterionIndex) => {
            const observation = observations[criterionIndex]?.trim();
            return observation ? [{ criterionIndex, observation }] : [];
          }),
        }),
      });
      await onReviewed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the review.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="task-review" aria-label="Review Worker result">
      <h3>Review the result</h3>
      <p>The Worker finished its run. Check the output yourself and record what you observed.</p>
      <small>Reviewing task revision {contract.revision}</small>
      {contract.acceptanceCriteria.length === 0 && (
        <p className="review-warning">
          No acceptance criteria were defined. Request changes, add criteria to the task, then run
          it again.
        </p>
      )}
      {contract.acceptanceCriteria.map((criterion, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: criteria belong to a frozen assignment contract and cannot reorder.
        <label className="review-criterion" key={`${index}-${criterion.behavior}`}>
          <strong>
            {index + 1}. {criterion.behavior}
          </strong>
          <span>How to check: {criterion.verification}</span>
          <textarea
            aria-label={`Evidence for criterion ${index + 1}`}
            rows={2}
            maxLength={2000}
            value={observations[index] ?? ""}
            placeholder="What did you inspect? Include the artifact, source or test result."
            onChange={(event) =>
              setObservations((current) => ({ ...current, [index]: event.target.value }))
            }
            disabled={saving}
          />
        </label>
      ))}
      <label className="review-criterion">
        <strong>Review notes</strong>
        <textarea
          aria-label="Review notes"
          rows={2}
          maxLength={4000}
          value={notes}
          placeholder="Your decision and any changes still needed."
          onChange={(event) => setNotes(event.target.value)}
          disabled={saving}
        />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="review-actions">
        <button
          type="button"
          disabled={saving || !notes.trim()}
          onClick={() => void submit("changes_requested")}
        >
          Request changes
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={saving || !notes.trim() || !canAccept}
          onClick={() => void submit("accepted")}
        >
          {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />} Accept result
        </button>
      </div>
    </section>
  );
}
