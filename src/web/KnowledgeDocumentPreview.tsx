import { CircleAlert, Download, Eye, LoaderCircle, RotateCcw } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  KnowledgeDocument,
  KnowledgeDocumentPreview as KnowledgeDocumentPreviewData,
  KnowledgeDocumentRevisions,
} from "../shared/contracts.js";
import { api } from "./api.js";

export interface KnowledgeDocumentPreviewHandle {
  selectRevision(revisionId: string): void;
}

interface KnowledgeDocumentPreviewProps {
  document: KnowledgeDocument;
  revisions?: KnowledgeDocumentRevisions;
  disabled?: boolean;
}

function previewErrorMessage(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : "Preview failed.";
}

function formatPreviewDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export const KnowledgeDocumentPreview = forwardRef<
  KnowledgeDocumentPreviewHandle,
  KnowledgeDocumentPreviewProps
>(function KnowledgeDocumentPreview({ document, revisions, disabled = false }, ref) {
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | undefined>(
    document.currentRevisionId ?? undefined,
  );
  const [preview, setPreview] = useState<KnowledgeDocumentPreviewData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const requestSequenceRef = useRef(0);
  const previousPreviewIdentityRef = useRef<string | undefined>(undefined);

  const loadPreview = useCallback(
    (revisionId: string | undefined) => {
      if (disabled) return;
      abortRef.current?.abort();
      const sequence = ++requestSequenceRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setSelectedRevisionId(revisionId);
      setPreview(undefined);
      setLoading(true);
      setError(undefined);
      const query = revisionId ? `?revisionId=${encodeURIComponent(revisionId)}` : "";
      const url = `/api/knowledge/${encodeURIComponent(document.id)}/preview${query}`;
      void api<KnowledgeDocumentPreviewData>(url, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
          setPreview(result);
          setSelectedRevisionId(result.revisionId ?? undefined);
        })
        .catch((caught: unknown) => {
          if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
          setError(previewErrorMessage(caught));
        })
        .finally(() => {
          if (!controller.signal.aborted && sequence === requestSequenceRef.current) {
            setLoading(false);
          }
        });
    },
    [document.id, disabled],
  );

  useImperativeHandle(
    ref,
    () => ({
      selectRevision: (revisionId: string) => {
        loadPreview(revisionId);
      },
    }),
    [loadPreview],
  );

  const previewIdentity = [
    document.id,
    document.workspaceId,
    document.currentRevisionId ?? "",
  ].join("|");
  useEffect(() => {
    if (previousPreviewIdentityRef.current === previewIdentity) return;
    previousPreviewIdentityRef.current = previewIdentity;
    abortRef.current?.abort();
    requestSequenceRef.current += 1;
    setPreview(undefined);
    setError(undefined);
    setLoading(false);
    const revisionId = previewIdentity.split("|")[2] || undefined;
    setSelectedRevisionId(revisionId);
  }, [previewIdentity]);

  useEffect(() => {
    if (!disabled) return;
    abortRef.current?.abort();
    requestSequenceRef.current += 1;
    setPreview(undefined);
    setError(undefined);
    setLoading(false);
  }, [disabled]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      requestSequenceRef.current += 1;
    };
  }, []);

  const selectedPreviewRevision = preview?.revisionId
    ? revisions?.revisions.find((revision) => revision.id === preview.revisionId)
    : undefined;
  const downloadHref = preview?.revisionId
    ? `/api/knowledge/${encodeURIComponent(document.id)}/revisions/${encodeURIComponent(preview.revisionId)}/content`
    : `/api/knowledge/${encodeURIComponent(document.id)}/content`;
  const versionLabel = preview
    ? preview.isCurrent
      ? "Current version"
      : "Prior version"
    : undefined;

  return (
    <section className="knowledge-preview" aria-label="Document preview">
      <div className="knowledge-preview-header">
        <Eye size={15} />
        <div>
          <strong>Preview</strong>
          <small>Read a version before downloading or restoring it.</small>
        </div>
        <button type="button" disabled={disabled || loading} onClick={() => loadPreview(undefined)}>
          <Eye size={14} />
          Preview current
        </button>
      </div>
      {preview?.supported && (
        <div className="knowledge-preview-body">
          <div className="preview-meta">
            <strong>{preview.fileName}</strong>
            <small>
              {versionLabel}
              {(selectedPreviewRevision?.createdAt ?? preview.createdAt)
                ? ` · ${formatPreviewDate(selectedPreviewRevision?.createdAt ?? preview.createdAt ?? "")}`
                : ""}
            </small>
          </div>
          <a href={downloadHref} download aria-label={`Download previewed ${preview.fileName}`}>
            <Download size={14} />
            Download
          </a>
        </div>
      )}
      {loading && (
        <p className="preview-status">
          <LoaderCircle className="spin" size={14} />
          Loading preview…
        </p>
      )}
      {error && (
        <div className="preview-error" role="alert">
          <CircleAlert size={14} />
          <span>{error}</span>
          <button type="button" onClick={() => loadPreview(selectedRevisionId)}>
            <RotateCcw size={14} />
            Retry
          </button>
        </div>
      )}
      {preview?.supported && (
        <div className="preview-content-wrap">
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable reading region needs keyboard focus for PageDown and arrow-key scrolling. */}
          <section className="preview-text" tabIndex={0} aria-label="Preview text">
            <pre>{preview.text}</pre>
          </section>
          {preview.truncated && (
            <p className="preview-truncated">
              Preview is truncated to the first 128 KiB. Download the file to read it in full.
            </p>
          )}
        </div>
      )}
      {preview && !preview.supported && (
        <div className="preview-unsupported">
          <CircleAlert size={14} />
          <span>{preview.reason ?? "This file cannot be previewed."}</span>
          <a href={downloadHref} download aria-label={`Download previewed ${preview.fileName}`}>
            <Download size={14} />
            Download {preview.fileName}
          </a>
        </div>
      )}
      {!preview && !loading && !error && (
        <p className="preview-status muted-text">
          Choose Preview current or use Preview in Version history to read this file as plain text.
        </p>
      )}
    </section>
  );
});
