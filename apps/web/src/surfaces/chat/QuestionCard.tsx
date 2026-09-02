import type { MasterQuestion } from "@nexestra/core";
import { Button, Tag } from "@nexestra/ui-kit";
import { useState } from "react";

export interface QuestionAnswer {
  readonly id: string;
  readonly answer: string;
}

export interface QuestionCardProps {
  readonly callId: string;
  readonly questions: readonly MasterQuestion[];
  /** True while the answers are being sent. */
  readonly busy?: boolean;
  readonly onSubmit: (answers: QuestionAnswer[]) => void;
}

/**
 * The inline card for `ask_user`.
 *
 * The Master's turn is suspended until this is answered, so the card is the
 * only thing on screen that can move the thread forward — hence its own block
 * in the timeline rather than a hint next to the composer.
 *
 * Options are suggestions, not a closed list: clicking one fills the field, and
 * the field stays editable so the user can amend it. Questions left blank are
 * dropped rather than sent as empty strings; the Master is told to fill the
 * gaps with stated assumptions instead.
 */
export function QuestionCard({ callId, questions, busy = false, onSubmit }: QuestionCardProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const set = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }));

  const filled = questions
    .map((question) => ({ id: question.id, answer: (answers[question.id] ?? "").trim() }))
    .filter((entry) => entry.answer.length > 0);

  const submit = () => {
    if (busy || filled.length === 0) return;
    onSubmit(filled);
  };

  return (
    <section className="card qcard" aria-label="Questions from Master">
      <div className="card__head">
        <span>Master is asking</span>
        <span className="card__title">
          {questions.length} question{questions.length === 1 ? "" : "s"}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <Tag tone="warn">answer to continue</Tag>
        </span>
      </div>

      <div className="card__body">
        {questions.map((question, index) => {
          const value = answers[question.id] ?? "";
          const inputId = `${callId}-${question.id}`;
          return (
            <div className="qcard__item" key={question.id}>
              <label className="qcard__question" htmlFor={inputId}>
                <span className="qcard__index">{index + 1}.</span> {question.text}
              </label>

              {question.options.length > 0 ? (
                <div className="qcard__options">
                  {question.options.map((option) => (
                    <button
                      type="button"
                      key={option}
                      className={`qcard__option${value === option ? " qcard__option--picked" : ""}`}
                      aria-pressed={value === option}
                      onClick={() => set(question.id, option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}

              <input
                id={inputId}
                className="qcard__input"
                type="text"
                value={value}
                disabled={busy}
                placeholder={
                  question.allowFreeText ? "Type an answer, or pick one above" : "Pick an option"
                }
                onChange={(event) => set(question.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
                }}
              />
            </div>
          );
        })}

        <div className="qcard__foot">
          <Button tone="primary" disabled={busy || filled.length === 0} onClick={submit}>
            {busy ? "Sending…" : "Submit answers"}
          </Button>
          <span className="nx-muted">
            {filled.length} of {questions.length} answered · anything left blank becomes a stated
            assumption
          </span>
        </div>
      </div>
    </section>
  );
}
