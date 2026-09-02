import type { AcceptanceCriterion, Spec } from "@nexestra/core";
import { Tag } from "@nexestra/ui-kit";

export interface SpecCardProps {
  readonly spec: Spec;
  /** Sidebar rendering: no card chrome, tighter. */
  readonly bare?: boolean;
}

/**
 * The Spec, rendered where the user has to read it.
 *
 * Two placements share this component: inline in Chat when an approval is
 * waiting (the moment the spec has to be judged) and in the sidebar as the
 * live picture of what the Master currently believes. Keeping them one
 * component is what stops the two drifting into different truths.
 *
 * The verification kind is shown on every acceptance criterion, because a
 * criterion that cannot be proved is the failure mode this whole surface
 * exists to make visible.
 */
export function SpecCard({ spec, bare = false }: SpecCardProps) {
  const open = spec.openQuestions.filter((question) => !question.answer);

  const body = (
    <>
      <div className="spec__goal">{spec.goal}</div>
      {spec.expectedOutcome ? <div className="spec__outcome">{spec.expectedOutcome}</div> : null}

      <SpecList title="In scope" items={spec.scope.in} bullet="+" />
      <SpecList title="Out of scope" items={spec.scope.out} bullet="−" muted />
      <SpecList title="Constraints" items={spec.constraints} bullet="!" />

      <div className="spec__section">
        <div className="spec__section-title">
          Acceptance criteria ({spec.acceptanceCriteria.length})
        </div>
        {spec.acceptanceCriteria.length === 0 ? (
          <div className="nx-muted">none yet</div>
        ) : (
          <ul className="spec__criteria">
            {spec.acceptanceCriteria.map((criterion) => (
              <CriterionRow key={criterion.id} criterion={criterion} />
            ))}
          </ul>
        )}
      </div>

      {open.length > 0 ? (
        <div className="spec__section">
          <div className="spec__section-title">Open questions ({open.length})</div>
          <ul className="spec__criteria">
            {open.map((question) => (
              <li key={question.id} className="spec__criterion">
                <span className="spec__bullet">?</span>
                <span>{question.question}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );

  if (bare) return <div className="spec spec--bare">{body}</div>;

  return (
    <section className="card" aria-label="Specification">
      <div className="card__head">
        <span>Spec</span>
        <span className="card__title">v{spec.version}</span>
        <span style={{ marginLeft: "auto" }}>
          <Tag tone={spec.frozen ? "accent" : "warn"}>{spec.frozen ? "frozen" : "draft"}</Tag>
        </span>
      </div>
      <div className="card__body">
        <div className="spec">{body}</div>
      </div>
    </section>
  );
}

function CriterionRow({ criterion }: { criterion: AcceptanceCriterion }) {
  const proof =
    criterion.verification.kind === "manual_review"
      ? criterion.verification.instructions
      : criterion.verification.command;

  return (
    <li className="spec__criterion">
      <span className="spec__bullet">{criterion.satisfied ? "[x]" : "[ ]"}</span>
      <span>
        {criterion.text}
        <br />
        <Tag tone={criterion.satisfied ? "accent" : "default"}>
          {criterion.verification.kind.replace("_", " ")}
        </Tag>{" "}
        <span className="nx-muted spec__proof">{proof}</span>
      </span>
    </li>
  );
}

function SpecList({
  title,
  items,
  bullet,
  muted = false,
}: {
  title: string;
  items: readonly string[];
  bullet: string;
  muted?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="spec__section">
      <div className="spec__section-title">{title}</div>
      <ul className="spec__criteria">
        {items.map((item) => (
          <li className="spec__criterion" key={item}>
            <span className="spec__bullet">{bullet}</span>
            <span className={muted ? "nx-muted" : undefined}>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
