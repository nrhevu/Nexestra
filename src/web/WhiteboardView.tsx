import { LoaderCircle, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { WORKSPACE_WHITEBOARD_MAX_CHARS, WorkspaceWhiteboardSchema } from "../shared/contracts.js";
import { api } from "./api.js";
import "./WhiteboardView.css";

type Phase = "loading" | "ready" | "saving" | "error";

export function WhiteboardView({ workspaceId }: { workspaceId: string }) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setPhase("loading");
    setError("");
    void api<unknown>(`/api/whiteboard?workspaceId=${encodeURIComponent(workspaceId)}`, {
      signal: controller.signal,
    })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const board = WorkspaceWhiteboardSchema.parse(payload);
        setContent(board.content);
        setSavedContent(board.content);
        setUpdatedAt(board.updatedAt);
        setPhase("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Unable to load the whiteboard.");
        setPhase("error");
      });
    return () => controller.abort();
  }, [workspaceId]);

  const dirty = content !== savedContent;
  const save = async () => {
    setPhase("saving");
    setError("");
    try {
      const payload = await api<unknown>(
        `/api/whiteboard?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "PUT", body: JSON.stringify({ content }) },
      );
      const board = WorkspaceWhiteboardSchema.parse(payload);
      setContent(board.content);
      setSavedContent(board.content);
      setUpdatedAt(board.updatedAt);
      setPhase("ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save the whiteboard.");
      setPhase("error");
    }
  };

  return (
    <section className="surface-view whiteboard-view" aria-label="Workspace whiteboard">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">WORKSPACE</p>
          <h1>Whiteboard</h1>
          <p className="subtitle">Keep a short Markdown plan, decision log, or working sketch.</p>
        </div>
        <span className="whiteboard-meta">
          {updatedAt ? `Saved ${new Date(updatedAt).toLocaleString()}` : "No saved notes"}
        </span>
      </header>
      <div className="whiteboard-editor">
        <textarea
          aria-label="Whiteboard Markdown"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          maxLength={WORKSPACE_WHITEBOARD_MAX_CHARS}
          disabled={phase === "loading" || phase === "saving"}
          placeholder="# Working notes\n\nCapture the next decision or experiment…"
          rows={18}
        />
        <div className="whiteboard-actions">
          <span className="whiteboard-counter">
            {content.length.toLocaleString()} / {WORKSPACE_WHITEBOARD_MAX_CHARS.toLocaleString()}{" "}
            characters
          </span>
          {error ? (
            <span className="whiteboard-error" role="alert">
              {error}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || phase === "saving" || phase === "loading"}
          >
            {phase === "saving" ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
            {phase === "saving" ? "Saving…" : "Save whiteboard"}
          </button>
        </div>
      </div>
    </section>
  );
}
