import { StatusDot, Tag } from "@nexestra/ui-kit";

export interface ToolCallCardProps {
  readonly name: string;
  readonly input: unknown;
  readonly ok?: boolean;
  readonly output?: unknown;
}

/**
 * One tool call, collapsed.
 *
 * A `read_workspace` result is thousands of lines; a `propose_plan` input is
 * the whole plan. Neither belongs in the reading flow of a conversation, but
 * both have to be inspectable when something looks wrong — so `<details>`,
 * closed, with the interesting part (name, outcome) in the summary.
 */
export function ToolCallCard({ name, input, ok, output }: ToolCallCardProps) {
  const pending = ok === undefined;

  return (
    <details className="card tool">
      <summary className="card__head tool__head">
        <StatusDot tone={pending ? "running" : ok ? "done" : "error"} />
        <span>tool</span>
        <span className="card__title">{name}</span>
        <span style={{ marginLeft: "auto" }}>
          <Tag tone={pending ? "warn" : ok ? "accent" : "danger"}>
            {pending ? "running" : ok ? "ok" : "failed"}
          </Tag>
        </span>
      </summary>
      <div className="card__body">
        <div className="tool__label">input</div>
        <pre className="card__pre">{render(input)}</pre>
        {output === undefined ? null : (
          <>
            <div className="tool__label">output</div>
            <pre className="card__pre tool__output">{render(output)}</pre>
          </>
        )}
      </div>
    </details>
  );
}

const MAX_CHARS = 4000;

function render(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "(empty)";
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… truncated` : text;
}
