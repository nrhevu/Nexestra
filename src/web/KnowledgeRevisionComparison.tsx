import { CircleAlert, GitCompare, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { KnowledgeDocumentPreview, KnowledgeDocumentRevisions } from "../shared/contracts.js";
import { KnowledgeDocumentPreviewSchema } from "../shared/contracts.js";
import { compareKnowledgeText, type KnowledgeTextDiff } from "../shared/knowledge-diff.js";
import { api } from "./api.js";

interface KnowledgeRevisionComparisonProps {
  documentId: string;
  revisions: KnowledgeDocumentRevisions;
  disabled?: boolean;
}

interface ComparisonState {
  left: KnowledgeDocumentPreview;
  right: KnowledgeDocumentPreview;
  diff?: KnowledgeTextDiff;
}

function previewLabel(preview: KnowledgeDocumentPreview): string {
  return `${preview.fileName} · ${preview.size.toLocaleString()} bytes`;
}

export function KnowledgeRevisionComparison({
  documentId,
  revisions,
  disabled = false,
}: KnowledgeRevisionComparisonProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<ComparisonState>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const toggleRevision = (revisionId: string) => {
    setComparison(undefined);
    setError(undefined);
    setSelected((current) => {
      if (current.includes(revisionId)) return current.filter((id) => id !== revisionId);
      return current.length < 2 ? [...current, revisionId] : [current[1] ?? revisionId, revisionId];
    });
  };

  const compare = async () => {
    if (selected.length !== 2 || disabled) return;
    setLoading(true);
    setError(undefined);
    try {
      const previews = await Promise.all(
        selected.map(async (revisionId) => {
          const raw = await api<unknown>(
            `/api/knowledge/${encodeURIComponent(documentId)}/preview?revisionId=${encodeURIComponent(revisionId)}`,
          );
          const parsed = KnowledgeDocumentPreviewSchema.safeParse(raw);
          if (!parsed.success) throw new Error("Revision comparison response was invalid.");
          return parsed.data;
        }),
      );
      const left = previews[0];
      const right = previews[1];
      if (!left || !right) throw new Error("Choose two revisions to compare.");
      setComparison({
        left,
        right,
        diff:
          left.supported && right.supported && left.text !== undefined && right.text !== undefined
            ? compareKnowledgeText(left.text, right.text)
            : undefined,
      });
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "Comparison failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="knowledge-revision-comparison" aria-label="Compare revisions">
      <div className="revision-comparison-header">
        <div>
          <strong>Compare revisions</strong>
          <small>Select two versions to inspect their bounded difference.</small>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || loading || selected.length !== 2}
          onClick={() => void compare()}
        >
          {loading ? <LoaderCircle className="spin" size={14} /> : <GitCompare size={14} />}
          {loading ? "Comparing…" : "Compare selected"}
        </button>
      </div>
      <div className="revision-comparison-selection">
        {revisions.revisions.map((revision) => (
          <label key={revision.id}>
            <input
              type="checkbox"
              checked={selected.includes(revision.id)}
              disabled={disabled || loading}
              onChange={() => toggleRevision(revision.id)}
              aria-label={`Select ${revision.fileName} for comparison`}
            />
            <span>{revision.fileName}</span>
          </label>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          <CircleAlert size={14} />
          {error}
        </p>
      )}
      {comparison && (
        <div className="revision-comparison-result">
          <p className="settings-hint">
            Comparing <strong>{previewLabel(comparison.left)}</strong> with{" "}
            <strong>{previewLabel(comparison.right)}</strong>. Preview text is redacted and bounded.
          </p>
          {!comparison.diff ? (
            <p className="muted-text">
              Metadata-only comparison: one or both revisions cannot be previewed as UTF-8 text.
            </p>
          ) : comparison.diff.truncated ? (
            <p className="muted-text">
              Text comparison is unavailable because the bounded diff limit was reached. Download
              the revisions to compare them externally.
            </p>
          ) : (
            <>
              <p className="settings-hint">
                +{comparison.diff.insertions} lines · -{comparison.diff.deletions} lines
              </p>
              <section className="knowledge-diff" aria-label="Revision line diff">
                <pre>
                  {(() => {
                    const diff = comparison.diff;
                    if (!diff) return null;
                    let lineKey = 0;
                    return diff.lines.map((line) => {
                      const key = `${line.kind}-${line.text}-${lineKey++}`;
                      return (
                        <span className={`knowledge-diff-${line.kind}`} key={key}>
                          {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}
                          {line.text}
                          {lineKey < diff.lines.length ? "\n" : ""}
                        </span>
                      );
                    });
                  })()}
                </pre>
              </section>
            </>
          )}
        </div>
      )}
    </section>
  );
}
