import type { WorkBrief } from "../../shared/contracts.js";

export function SourceBrief({ brief }: { brief: WorkBrief }) {
  return (
    <details className="source-brief">
      <summary>
        Source brief · revision {brief.revision} · {brief.status}
      </summary>
      <strong>{brief.title}</strong>
      <p>{brief.outcome || "Outcome not yet specified."}</p>
      {brief.deliverables.length > 0 && (
        <>
          <h4>Deliverables</h4>
          <ul>
            {[...new Set(brief.deliverables)].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {brief.constraints && (
        <>
          <h4>Constraints</h4>
          <p>{brief.constraints}</p>
        </>
      )}
      {brief.nonGoals && (
        <>
          <h4>Out of scope</h4>
          <p>{brief.nonGoals}</p>
        </>
      )}
      {brief.openQuestions && (
        <>
          <h4>Open questions</h4>
          <p>{brief.openQuestions}</p>
        </>
      )}
      {brief.acceptanceCriteria.length > 0 && (
        <>
          <h4>Source success criteria</h4>
          <ol>
            {[...new Map(brief.acceptanceCriteria.map((item) => [JSON.stringify(item), item]))].map(
              ([key, item]) => (
                <li key={key}>
                  {item.behavior}
                  <p>Check: {item.verification}</p>
                </li>
              ),
            )}
          </ol>
        </>
      )}
      <p className="source-brief-note">
        This saved source stays with the task. Later brief edits do not change it. The task's
        explicit requirements govern its work.
      </p>
    </details>
  );
}
