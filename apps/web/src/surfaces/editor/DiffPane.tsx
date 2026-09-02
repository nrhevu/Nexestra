import { Tag } from "@nexestra/ui-kit";
import { useRunDiff } from "../../lib/api.js";

/**
 * The run's worktree against the branch it was cut from, as a unified diff.
 *
 * A unified diff rather than a side-by-side merge view, because that is what
 * git produced and what the reviewer (a second harness) was shown: the two
 * halves of a review should be looking at the same artefact. The patch is
 * rendered a line at a time so the hunk headers, additions and deletions can
 * carry colour without a syntax-highlighting pass over a file that does not
 * exist on either side of the diff.
 */
export function DiffPane({ runId }: { runId: string | undefined }) {
  const diff = useRunDiff(runId);

  if (!runId) return <div className="state">no run selected yet</div>;
  if (diff.isPending) return <div className="state">computing the diff…</div>;
  if (diff.isError) return <div className="state">{diff.error.message}</div>;

  const data = diff.data;
  if (!data || data.patch.trim().length === 0) {
    return <div className="state">this worktree has no changes against {data?.base ?? "base"}</div>;
  }

  return (
    <div className="diff">
      <div className="diff__head">
        <span className="nx-muted">vs {data.base}</span>
        {data.files.map((file) => (
          <Tag
            key={file.path}
            tone={file.kind === "add" ? "accent" : file.kind === "delete" ? "danger" : "info"}
          >
            {file.path}
          </Tag>
        ))}
        {data.truncated ? <Tag tone="warn">truncated</Tag> : null}
      </div>
      <pre className="diff__body nx-scroll">
        {data.patch.split("\n").map((line, index) => (
          // The patch is immutable text; the index is a stable key for it.
          // biome-ignore lint/suspicious/noArrayIndexKey: patch lines have no id
          <span key={index} className={`diff__line diff__line--${classify(line)}`}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}

function classify(line: string): "add" | "del" | "hunk" | "meta" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file")) {
    return "meta";
  }
  return "ctx";
}
