import {
  ArrowUpRight,
  Check,
  FileText,
  LoaderCircle,
  Plus,
  RefreshCw,
  Target,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { BootstrapData, Thread, WorkBrief, WorkBriefContent } from "../../shared/contracts.js";
import { workBriefReadiness } from "../../shared/contracts.js";
import { api } from "../api.js";

export function WorkBriefs(props: {
  data: BootstrapData;
  initialThreadId?: string;
  onChanged: () => Promise<unknown>;
  onThread: (threadId: string) => void;
  onDraftTask?: (brief: WorkBrief) => void;
}) {
  const [selectedId, setSelectedId] = useState(props.initialThreadId ?? props.data.threads[0]?.id);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const selected =
    props.data.threads.find((thread) => thread.id === selectedId) ?? props.data.threads[0];
  const briefs = new Map(props.data.workBriefs.map((brief) => [brief.threadId, brief]));

  async function createThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const thread = await api<Thread>("/api/threads", {
        method: "POST",
        body: JSON.stringify({ workspaceId: props.data.workspace.id, name: form.get("name") }),
      });
      await props.onChanged();
      setSelectedId(thread.id);
      setCreating(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface-view brief-surface">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SHARED UNDERSTANDING</p>
          <h1>Work briefs</h1>
          <p className="brief-subtitle">Agree on the outcome. Make good work recognizable.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setCreating(true)}>
          <Plus size={16} /> New brief
        </button>
      </header>
      {creating && (
        <form className="brief-create" onSubmit={(event) => void createThread(event)}>
          <label>
            Start a conversation for this brief
            <input
              name="name"
              aria-label="New brief name"
              placeholder="A research question, a design, a document…"
              maxLength={80}
              required
              disabled={busy}
            />
          </label>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create conversation"}
          </button>
          <button type="button" onClick={() => setCreating(false)} disabled={busy}>
            Cancel
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      <div className="brief-layout">
        <nav className="brief-list" aria-label="Brief conversations">
          <p className="eyebrow">CONVERSATIONS</p>
          {props.data.threads.map((thread) => {
            const brief = briefs.get(thread.id);
            return (
              <button
                key={thread.id}
                type="button"
                className={
                  thread.id === selected?.id ? "brief-list-item selected" : "brief-list-item"
                }
                aria-current={thread.id === selected?.id ? "page" : undefined}
                onClick={() => setSelectedId(thread.id)}
              >
                <FileText size={16} />
                <span>
                  <strong>{brief?.title ?? thread.name}</strong>
                  <small>{brief ? `${brief.kind} · ${brief.status}` : "Ready for an idea"}</small>
                </span>
                {brief?.status === "confirmed" && <Check size={14} />}
              </button>
            );
          })}
          {props.data.threads.length === 0 && (
            <p className="brief-subtitle">Create a brief to start a conversation.</p>
          )}
        </nav>
        {selected && (
          <BriefEditor
            key={selected.id}
            thread={selected}
            latest={briefs.get(selected.id)}
            onChanged={props.onChanged}
            onThread={props.onThread}
            onDraftTask={props.onDraftTask}
          />
        )}
      </div>
    </div>
  );
}

function BriefEditor(props: {
  thread: Thread;
  latest?: WorkBrief;
  onChanged: () => Promise<unknown>;
  onThread: (threadId: string) => void;
  onDraftTask?: (brief: WorkBrief) => void;
}) {
  const [saved, setSaved] = useState(props.latest);
  const [draft, setDraft] = useState<WorkBriefContent>(() =>
    contentOf(props.latest, props.thread.name),
  );
  const [criterionKeys, setCriterionKeys] = useState(() =>
    (props.latest?.acceptanceCriteria ?? []).map(() => crypto.randomUUID()),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(contentOf(saved, props.thread.name));
  const changedElsewhere = (props.latest?.revision ?? 0) > (saved?.revision ?? 0);
  const gaps = workBriefReadiness(draft);
  const confirmed = saved?.status === "confirmed" && !dirty;

  function change<K extends keyof WorkBriefContent>(key: K, value: WorkBriefContent[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(undefined);
  }

  async function reload() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await api<{ workBrief: WorkBrief | null }>(
        `/api/threads/${encodeURIComponent(props.thread.id)}/brief`,
      );
      setSaved(response.workBrief ?? undefined);
      setDraft(contentOf(response.workBrief ?? undefined, props.thread.name));
      setCriterionKeys(
        (response.workBrief?.acceptanceCriteria ?? []).map(() => crypto.randomUUID()),
      );
      setNotice("Loaded the latest brief.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const brief = await api<WorkBrief>(
        `/api/threads/${encodeURIComponent(props.thread.id)}/brief`,
        {
          method: "PUT",
          body: JSON.stringify({
            ...draft,
            deliverables: draft.deliverables.map((item) => item.trim()).filter(Boolean),
            expectedRevision: saved?.revision ?? 0,
          }),
        },
      );
      setSaved(brief);
      setDraft(contentOf(brief, props.thread.name));
      setNotice("Draft saved. It will be included when you next mention an agent here.");
      await props.onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!saved || dirty) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const brief = await api<WorkBrief>(
        `/api/threads/${encodeURIComponent(props.thread.id)}/brief/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision: saved.revision }),
        },
      );
      setSaved(brief);
      setNotice("Scope confirmed. Continue in the conversation when you are ready to work.");
      await props.onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="brief-editor" aria-label="Work brief editor">
      <div className="brief-editor-heading">
        <div>
          <span className={confirmed ? "brief-status confirmed" : "brief-status"}>
            {confirmed ? <Check size={13} /> : <Target size={13} />}
            {confirmed ? "Scope confirmed" : "Working draft"}
          </span>
          <small>
            {saved
              ? `Revision ${saved.revision} · updated by ${saved.updatedBy.kind === "user" ? "you" : "an agent"}`
              : "An idea can start small"}
            {dirty ? " · Unsaved changes" : ""}
          </small>
        </div>
        <button type="button" onClick={() => props.onThread(props.thread.id)}>
          # {props.thread.name} <ArrowUpRight size={14} />
        </button>
      </div>
      {changedElsewhere && (
        <p className="brief-alert" role="status">
          A newer revision is available. Your edits are preserved; compare them before reloading.
        </p>
      )}
      {error && (
        <p className="brief-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="brief-notice" role="status">
          {notice}
        </p>
      )}
      <form onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy}>
          <div className="brief-field-pair">
            <label>
              Title
              <input
                aria-label="Brief title"
                value={draft.title}
                onChange={(event) => change("title", event.target.value)}
                maxLength={160}
                required
              />
            </label>
            <label>
              Type of work
              <select
                value={draft.kind}
                onChange={(event) => change("kind", event.target.value as WorkBriefContent["kind"])}
              >
                <option value="mixed">Mixed work</option>
                <option value="research">Research</option>
                <option value="document">Document</option>
                <option value="design">Design</option>
                <option value="code">Code</option>
              </select>
            </label>
          </div>
          <label>
            Desired outcome<span>What should be different when this work is useful?</span>
            <textarea
              value={draft.outcome}
              onChange={(event) => change("outcome", event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Help me decide which audience to focus on for our next launch."
            />
          </label>
          <label>
            Deliverables
            <span>One per line, up to 10. A memo, a prototype, a slide deck, a change…</span>
            <textarea
              value={draft.deliverables.join("\n")}
              onChange={(event) => change("deliverables", event.target.value.split("\n"))}
              rows={3}
              maxLength={2409}
              placeholder={
                "A comparison of three audiences\nA recommendation with supporting sources"
              }
            />
          </label>
          <div className="brief-field-pair equal">
            <label>
              Constraints<span>Audience, time, resources, preferences and assumptions.</span>
              <textarea
                value={draft.constraints}
                onChange={(event) => change("constraints", event.target.value)}
                rows={3}
                maxLength={2000}
              />
            </label>
            <label>
              Out of scope<span>Keep the work focused.</span>
              <textarea
                value={draft.nonGoals}
                onChange={(event) => change("nonGoals", event.target.value)}
                rows={3}
                maxLength={1000}
              />
            </label>
          </div>
          <div className="brief-criteria-heading">
            <div>
              <h2>Success criteria</h2>
              <p>Pair every desired behavior with a way to check it.</p>
            </div>
            <button
              type="button"
              disabled={draft.acceptanceCriteria.length >= 10}
              onClick={() => {
                setCriterionKeys((keys) => [...keys, crypto.randomUUID()]);
                change("acceptanceCriteria", [
                  ...draft.acceptanceCriteria,
                  { behavior: "", verification: "" },
                ]);
              }}
            >
              <Plus size={14} /> Add criterion
            </button>
          </div>
          {draft.acceptanceCriteria.length === 0 && (
            <p className="brief-criteria-empty">
              What evidence would convince you the work is good?
            </p>
          )}
          {draft.acceptanceCriteria.map((criterion, index) => (
            <div className="brief-criterion" key={criterionKeys[index]}>
              <span className="brief-criterion-number">{index + 1}</span>
              <label>
                Success criterion {index + 1}
                <textarea
                  value={criterion.behavior}
                  onChange={(event) =>
                    change(
                      "acceptanceCriteria",
                      draft.acceptanceCriteria.map((item, position) =>
                        position === index ? { ...item, behavior: event.target.value } : item,
                      ),
                    )
                  }
                  maxLength={400}
                  rows={2}
                  required
                />
              </label>
              <label>
                How to check {index + 1}
                <textarea
                  value={criterion.verification}
                  onChange={(event) =>
                    change(
                      "acceptanceCriteria",
                      draft.acceptanceCriteria.map((item, position) =>
                        position === index ? { ...item, verification: event.target.value } : item,
                      ),
                    )
                  }
                  maxLength={400}
                  rows={2}
                  required
                  placeholder="A source check, a rubric, a test, or your review."
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove criterion ${index + 1}`}
                onClick={() => {
                  setCriterionKeys((keys) => keys.filter((_, position) => position !== index));
                  change(
                    "acceptanceCriteria",
                    draft.acceptanceCriteria.filter((_, position) => position !== index),
                  );
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <label>
            Open questions
            <span>Record uncertainty here. Resolve these before confirming the scope.</span>
            <textarea
              value={draft.openQuestions}
              onChange={(event) => change("openQuestions", event.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Who will read the final recommendation?"
            />
          </label>
          <div className="brief-readiness">
            {gaps.length > 0 ? (
              <>
                <strong>Before confirming</strong>
                <ul>
                  {gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                <Check size={15} />{" "}
                {dirty || !saved
                  ? "Save this draft to confirm its scope."
                  : confirmed
                    ? "Shared scope is recorded. Revisions will return it to draft."
                    : "This brief is ready for your scope review."}
              </p>
            )}
            <small>
              Confirmation records agreement on the brief. Execution and verification happen
              separately.
            </small>
          </div>
          <div className="brief-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />} Save draft
            </button>
            <button
              type="button"
              disabled={!saved || dirty || gaps.length > 0 || confirmed || changedElsewhere}
              onClick={() => void confirm()}
            >
              Confirm scope
            </button>
            <button type="button" onClick={() => void reload()}>
              <RefreshCw size={14} /> Reload latest
            </button>
            {props.onDraftTask && (
              <button
                type="button"
                disabled={!saved || dirty || changedElsewhere}
                onClick={() => saved && props.onDraftTask?.(saved)}
              >
                <Plus size={14} /> Draft task
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </section>
  );
}

function contentOf(brief: WorkBrief | undefined, title: string): WorkBriefContent {
  return {
    title: brief?.title ?? title,
    kind: brief?.kind ?? "mixed",
    outcome: brief?.outcome ?? "",
    deliverables: brief?.deliverables ?? [],
    constraints: brief?.constraints ?? "",
    nonGoals: brief?.nonGoals ?? "",
    acceptanceCriteria: brief?.acceptanceCriteria ?? [],
    openQuestions: brief?.openQuestions ?? "",
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : "Could not update the work brief.";
}
