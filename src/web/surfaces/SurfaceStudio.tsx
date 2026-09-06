import {
  Archive,
  Braces,
  Copy,
  Download,
  FileText,
  LayoutDashboard,
  LayoutGrid,
  Plus,
  Power,
  RefreshCw,
  Table2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BootstrapData } from "../../shared/contracts.js";
import type {
  SaveSurfaceRecordInput,
  SurfaceRecord,
  WorkspaceSurface,
} from "../../shared/surfaces.js";
import { api } from "../api.js";
import {
  NewSurfaceDialog,
  SurfaceDefinitionDialog,
  SurfaceRecordDialog,
} from "./SurfaceDialogs.js";
import { SurfaceView } from "./SurfaceViews.js";
import "./studio.css";

const viewIcons = { table: Table2, board: LayoutDashboard, canvas: LayoutGrid, document: FileText };

export function SurfaceStudio({
  data,
  createSequence = 0,
  onChanged,
}: {
  data: BootstrapData;
  createSequence?: number;
  onChanged: () => Promise<void>;
}) {
  const [catalog, setCatalog] = useState(data.surfaces ?? []);
  const [selectedId, setSelectedId] = useState(
    () => new URLSearchParams(window.location.search).get("surfaceId") ?? data.surfaces?.[0]?.id,
  );
  const [selection, setSelection] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [definition, setDefinition] = useState<WorkspaceSurface>();
  const [editor, setEditor] = useState<{
    surface: WorkspaceSurface;
    record?: SurfaceRecord;
    group?: string;
  }>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [working, setWorking] = useState(false);
  const previousCreate = useRef(createSequence);
  useEffect(() => {
    setCatalog(data.surfaces ?? []);
  }, [data.surfaces]);
  useEffect(() => {
    if (createSequence !== previousCreate.current) {
      previousCreate.current = createSequence;
      setCreating(true);
    }
  }, [createSequence]);
  const selected = catalog.find((surface) => surface.id === selectedId) ?? catalog[0];
  const choose = (id: string) => {
    setSelectedId(id);
    setSelection([]);
    setShowArchived(false);
    setError(undefined);
    setNotice(undefined);
    window.history.replaceState({}, "", `/surfaces/custom?surfaceId=${encodeURIComponent(id)}`);
  };
  const accept = async (surface: WorkspaceSurface) => {
    setCatalog((current) => [surface, ...current.filter((entry) => entry.id !== surface.id)]);
    setSelection((current) =>
      current.filter((id) =>
        surface.records.some((record) => record.id === id && !record.archived),
      ),
    );
    await onChanged();
  };
  const mutate = async (action: () => Promise<WorkspaceSurface>, message: string) => {
    setWorking(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await accept(await action());
      setNotice(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the surface.");
    } finally {
      setWorking(false);
    }
  };
  const saveRecord = (record: SurfaceRecord, patch: Partial<SaveSurfaceRecordInput>) => {
    if (!selected) return Promise.resolve();
    return mutate(
      () =>
        api<WorkspaceSurface>(`/api/surfaces/${selected.id}/records`, {
          method: "POST",
          body: JSON.stringify({
            id: record.id,
            expectedRevision: selected.revision,
            data: record.data,
            color: record.color,
            position: record.position,
            ...patch,
          }),
        }),
      "Surface updated.",
    );
  };
  return (
    <div className="surface-view surface-studio">
      <header className="workspace-header">
        <div>
          <p className="eyebrow">SHARED WORKSPACE</p>
          <h1>Custom surfaces</h1>
          <p className="subtitle">Give your work a useful shape. Build understanding together.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setCreating(true)}>
          <Plus size={16} /> New surface
        </button>
      </header>
      <div className="studio-layout">
        <nav className="studio-catalog" aria-label="Custom surfaces">
          <p>YOUR SURFACES</p>
          {catalog.map((surface) => {
            const Icon = viewIcons[surface.manifest.view];
            return (
              <button
                type="button"
                key={surface.id}
                className={selected?.id === surface.id ? "selected" : ""}
                onClick={() => choose(surface.id)}
                aria-pressed={selected?.id === surface.id}
              >
                <Icon size={16} />
                <span>
                  <strong>{surface.manifest.name}</strong>
                  <small>
                    {surface.manifest.view} ·{" "}
                    {surface.records.filter((record) => !record.archived).length} records
                    {!surface.enabled ? " · disabled" : ""}
                  </small>
                </span>
              </button>
            );
          })}
          {catalog.length === 0 && (
            <p className="studio-catalog-empty">
              Your boards, canvases and documents will appear here.
            </p>
          )}
        </nav>
        <section className="studio-content" aria-label="Surface workspace">
          {!selected ? (
            <div className="studio-empty">
              <div className="studio-empty-art">
                <LayoutGrid size={42} />
                <Table2 size={30} />
                <FileText size={32} />
              </div>
              <h2>A place to think together</h2>
              <p>
                Compare research in a table. Arrange ideas on a canvas. Keep a living document.
                Start with a template, or import a definition written by your harness.
              </p>
              <button type="button" className="primary-button" onClick={() => setCreating(true)}>
                <Plus size={16} /> Create your first surface
              </button>
            </div>
          ) : (
            <>
              <div className="studio-surface-heading">
                <div>
                  <h2>{selected.manifest.name}</h2>
                  <p>{selected.manifest.description}</p>
                  <small>
                    {selected.manifest.view} · revision {selected.revision} · updated by{" "}
                    {selected.updatedBy.kind === "user" ? "you" : "an agent"}
                  </small>
                </div>
              </div>
              <div className="studio-toolbar">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!selected.enabled || working}
                  onClick={() => setEditor({ surface: selected })}
                >
                  <Plus size={14} /> Add record
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    void mutate(() => api(`/api/surfaces/${selected.id}`), "Latest surface loaded.")
                  }
                >
                  <RefreshCw size={14} /> Reload
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const context = await api(
                        `/api/surfaces/${selected.id}/context${selection.length ? `?ids=${selection.map(encodeURIComponent).join(",")}` : ""}`,
                      );
                      await navigator.clipboard.writeText(JSON.stringify(context, null, 2));
                      setNotice("Context copied. Paste it into a conversation with your agent.");
                    } catch (caught) {
                      setError(
                        caught instanceof Error ? caught.message : "Could not copy context.",
                      );
                    }
                  }}
                >
                  <Copy size={14} />{" "}
                  {selection.length ? `Copy ${selection.length} selected` : "Copy context"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const definition = {
                      manifest: selected.manifest,
                      records: selected.records
                        .filter((record) => !record.archived)
                        .map(({ data, position, color }) => ({ data, position, color })),
                    };
                    const url = URL.createObjectURL(
                      new Blob([JSON.stringify(definition, null, 2)], { type: "application/json" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `${selected.manifest.pluginId}.json`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download size={14} /> Export
                </button>
                <button
                  type="button"
                  disabled={!selected.enabled || working}
                  onClick={() => setDefinition(selected)}
                >
                  <Braces size={14} /> Definition
                </button>
                <button
                  type="button"
                  className={showArchived ? "selected" : ""}
                  onClick={() => setShowArchived(!showArchived)}
                >
                  <Archive size={14} /> Archived
                </button>
                <button
                  type="button"
                  disabled={working}
                  onClick={() =>
                    void mutate(
                      () =>
                        api(`/api/surfaces/${selected.id}/enabled`, {
                          method: "PATCH",
                          body: JSON.stringify({
                            expectedRevision: selected.revision,
                            enabled: !selected.enabled,
                          }),
                        }),
                      selected.enabled
                        ? "Surface disabled. Its data is retained."
                        : "Surface enabled.",
                    )
                  }
                >
                  <Power size={14} /> {selected.enabled ? "Disable" : "Enable"}
                </button>
              </div>
              {error && (
                <p role="alert" className="studio-banner error">
                  {error}
                </p>
              )}
              {notice && (
                <p role="status" className="studio-banner">
                  {notice}
                </p>
              )}
              {!selected.enabled && (
                <p className="studio-banner">
                  This surface is disabled. Your records are retained; enable it to edit or use
                  agent tools.
                </p>
              )}
              {showArchived ? (
                <div className="studio-archive-list">
                  {selected.records
                    .filter((record) => record.archived)
                    .map((record) => (
                      <div key={record.id}>
                        <span>{String(record.data[selected.manifest.titleField])}</span>
                        <button
                          type="button"
                          disabled={!selected.enabled || working}
                          onClick={() =>
                            void mutate(
                              () =>
                                api(`/api/surfaces/${selected.id}/records/${record.id}/archive`, {
                                  method: "PATCH",
                                  body: JSON.stringify({
                                    expectedRevision: selected.revision,
                                    archived: false,
                                  }),
                                }),
                              "Record restored.",
                            )
                          }
                        >
                          Restore
                        </button>
                      </div>
                    ))}
                  {!selected.records.some((record) => record.archived) && (
                    <p>No archived records.</p>
                  )}
                </div>
              ) : (
                <SurfaceView
                  key={selected.id}
                  surface={selected}
                  selection={selection}
                  working={working}
                  onSelect={(id) =>
                    setSelection((current) =>
                      current.includes(id)
                        ? current.filter((entry) => entry !== id)
                        : current.length < 20
                          ? [...current, id]
                          : current,
                    )
                  }
                  onEdit={(record) => setEditor({ surface: selected, record })}
                  onCreate={(group) => setEditor({ surface: selected, group })}
                  onSave={saveRecord}
                />
              )}
            </>
          )}
        </section>
      </div>
      {creating && (
        <NewSurfaceDialog
          workspaceId={data.workspace.id}
          onClose={() => setCreating(false)}
          onCreated={async (surface) => {
            await accept(surface);
            choose(surface.id);
            setCreating(false);
          }}
        />
      )}
      {definition && (
        <SurfaceDefinitionDialog
          surface={definition}
          onClose={() => setDefinition(undefined)}
          onSaved={async (surface) => {
            await accept(surface);
            setDefinition(undefined);
          }}
        />
      )}
      {editor && (
        <SurfaceRecordDialog
          surface={editor.surface}
          record={editor.record}
          group={editor.group}
          onClose={() => setEditor(undefined)}
          onSaved={async (surface) => {
            await accept(surface);
            setEditor(undefined);
          }}
        />
      )}
    </div>
  );
}
