import { Archive, Copy, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { z } from "zod";
import {
  CreateSurfaceSchema,
  type SurfaceField,
  type SurfaceManifest,
  SurfaceManifestSchema,
  type SurfaceRecord,
  surfaceDataError,
  surfaceTemplate,
  type WorkspaceSurface,
} from "../../shared/surfaces.js";
import { api } from "../api.js";
import { Modal } from "../components/Modal.js";

function message(error: unknown) {
  return error instanceof z.ZodError
    ? (error.issues[0]?.message ?? "Invalid definition.")
    : error instanceof Error
      ? error.message
      : "Could not save your changes.";
}
function Actions({ busy, onClose, label }: { busy: boolean; onClose: () => void; label: string }) {
  return (
    <div className="modal-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className="primary-button" disabled={busy}>
        {busy && <LoaderCircle size={15} className="spin" />}
        {label}
      </button>
    </div>
  );
}

export function NewSurfaceDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (surface: WorkspaceSurface) => Promise<void>;
}) {
  const [name, setName] = useState("Ideas & decisions");
  const [view, setView] = useState<SurfaceManifest["view"]>("canvas");
  const [importing, setImporting] = useState(false);
  const [definition, setDefinition] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Modal
      title="Create a surface"
      eyebrow="A SHARED PLACE TO WORK"
      onClose={onClose}
      closeDisabled={busy}
    >
      <form
        className="studio-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const input = importing
              ? CreateSurfaceSchema.parse(JSON.parse(definition))
              : { manifest: surfaceTemplate(view, name), records: [] };
            await onCreated(
              await api<WorkspaceSurface>("/api/surfaces", {
                method: "POST",
                body: JSON.stringify({ ...input, workspaceId }),
              }),
            );
          } catch (caught) {
            setError(message(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="studio-mode-tabs">
          <button type="button" aria-pressed={!importing} onClick={() => setImporting(false)}>
            Use a template
          </button>
          <button type="button" aria-pressed={importing} onClick={() => setImporting(true)}>
            Import definition
          </button>
        </div>
        {importing ? (
          <label>
            Plugin definition JSON
            <textarea
              aria-label="Plugin definition JSON"
              className="studio-code"
              rows={14}
              value={definition}
              onChange={(event) => setDefinition(event.target.value)}
              maxLength={400000}
              placeholder={'{"manifest": {"apiVersion": 1, ...}, "records": []}'}
              required
            />
            <small>
              Import a definition exported from Nexestra or written by your harness. Definitions
              describe fields and views; they do not run code.
            </small>
          </label>
        ) : (
          <>
            <label>
              Name
              <input
                aria-label="Surface name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
              />
            </label>
            <div className="studio-template-grid">
              {(
                [
                  ["canvas", "Whiteboard", "Arrange ideas, questions and decisions."],
                  ["table", "Table", "Compare research, sources and options."],
                  ["board", "Board", "Move ideas through stages."],
                  ["document", "Document", "Keep living notes and narrative."],
                ] as const
              ).map(([kind, title, description]) => (
                <button
                  type="button"
                  key={kind}
                  aria-pressed={view === kind}
                  onClick={() => setView(kind)}
                >
                  <strong>{title}</strong>
                  <span>{description}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <Actions
          busy={busy}
          onClose={onClose}
          label={importing ? "Import surface" : "Create surface"}
        />
      </form>
    </Modal>
  );
}

export function SurfaceDefinitionDialog({
  surface,
  onClose,
  onSaved,
}: {
  surface: WorkspaceSurface;
  onClose: () => void;
  onSaved: (surface: WorkspaceSurface) => Promise<void>;
}) {
  const [definition, setDefinition] = useState(JSON.stringify(surface.manifest, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Modal
      title="Surface definition"
      eyebrow="EXTEND FIELDS AND VIEWS"
      onClose={onClose}
      closeDisabled={busy}
      wide
    >
      <form
        className="studio-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const manifest = SurfaceManifestSchema.parse(JSON.parse(definition));
            await onSaved(
              await api(`/api/surfaces/${surface.id}`, {
                method: "PUT",
                body: JSON.stringify({ expectedRevision: surface.revision, manifest }),
              }),
            );
          } catch (caught) {
            setError(message(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Change the fields or view using a validated manifest. Existing records must remain valid;
          incompatible changes keep your saved data intact.
        </p>
        <label>
          Manifest JSON
          <textarea
            aria-label="Manifest JSON"
            className="studio-code"
            rows={19}
            value={definition}
            maxLength={40000}
            onChange={(event) => setDefinition(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <Actions busy={busy} onClose={onClose} label="Save definition" />
      </form>
    </Modal>
  );
}

export function SurfaceRecordDialog({
  surface,
  record,
  group,
  onClose,
  onSaved,
}: {
  surface: WorkspaceSurface;
  record?: SurfaceRecord;
  group?: string;
  onClose: () => void;
  onSaved: (surface: WorkspaceSurface) => Promise<void>;
}) {
  const [data, setData] = useState<SurfaceRecord["data"]>(() =>
    record
      ? { ...record.data }
      : {
          [surface.manifest.titleField]: "",
          ...(surface.manifest.groupBy
            ? {
                [surface.manifest.groupBy]:
                  group ??
                  surface.manifest.fields.find((field) => field.key === surface.manifest.groupBy)
                    ?.options?.[0] ??
                  "",
              }
            : {}),
        },
  );
  const [color, setColor] = useState<SurfaceRecord["color"]>(record?.color ?? "lilac");
  const [position, setPosition] = useState(
    record?.position ?? {
      x: 40 + (surface.records.length % 4) * 270,
      y: 40 + (Math.floor(surface.records.length / 4) % 5) * 250,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const change = (key: string, value: SurfaceRecord["data"][string] | undefined) =>
    setData((current) => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  return (
    <Modal
      title={record ? "Edit record" : "Add a record"}
      eyebrow={surface.manifest.name}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form
        className="studio-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const invalid = surfaceDataError(surface.manifest, data);
            if (invalid) throw new Error(invalid);
            await onSaved(
              await api(`/api/surfaces/${surface.id}/records`, {
                method: "POST",
                body: JSON.stringify({
                  expectedRevision: surface.revision,
                  ...(record ? { id: record.id } : {}),
                  data,
                  color,
                  position,
                }),
              }),
            );
          } catch (caught) {
            setError(message(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        {surface.manifest.fields.map((field) => (
          <RecordInput
            key={field.key}
            field={field}
            value={data[field.key]}
            required={field.key === surface.manifest.titleField}
            onChange={(value) => change(field.key, value)}
          />
        ))}
        {(surface.manifest.view === "canvas" || surface.manifest.view === "board") && (
          <label>
            Card color
            <select
              aria-label="Card color"
              value={color}
              onChange={(event) => setColor(event.target.value as SurfaceRecord["color"])}
            >
              {["lilac", "blue", "green", "yellow", "rose"].map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        )}
        {surface.manifest.view === "canvas" && (
          <details className="studio-position">
            <summary>Position on canvas</summary>
            <div>
              <label>
                X
                <input
                  aria-label="Canvas X"
                  type="number"
                  min={0}
                  max={2000}
                  value={position.x}
                  onChange={(event) => setPosition({ ...position, x: Number(event.target.value) })}
                />
              </label>
              <label>
                Y
                <input
                  aria-label="Canvas Y"
                  type="number"
                  min={0}
                  max={1600}
                  value={position.y}
                  onChange={(event) => setPosition({ ...position, y: Number(event.target.value) })}
                />
              </label>
            </div>
          </details>
        )}
        {error && (
          <div role="alert" className="studio-form-error">
            <p>{error}</p>
            <small>
              Your draft is retained here. For a conflict, copy your draft, close this editor, then
              reload and reconcile the latest record.
            </small>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard.writeText(
                  JSON.stringify({ data, position, color }, null, 2),
                )
              }
            >
              <Copy size={13} /> Copy draft
            </button>
          </div>
        )}
        {record && (
          <button
            type="button"
            className="studio-archive-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onSaved(
                  await api(`/api/surfaces/${surface.id}/records/${record.id}/archive`, {
                    method: "PATCH",
                    body: JSON.stringify({ expectedRevision: surface.revision, archived: true }),
                  }),
                );
              } catch (caught) {
                setError(message(caught));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Archive size={14} /> Archive saved record
          </button>
        )}
        <Actions busy={busy} onClose={onClose} label="Save record" />
      </form>
    </Modal>
  );
}

function RecordInput({
  field,
  value,
  required,
  onChange,
}: {
  field: SurfaceField;
  value: SurfaceRecord["data"][string] | undefined;
  required: boolean;
  onChange: (value: SurfaceRecord["data"][string] | undefined) => void;
}) {
  const inputId = useId();
  if (field.type === "checkbox")
    return (
      <label className="studio-checkbox">
        <input
          type="checkbox"
          aria-label={field.label}
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  return (
    <label htmlFor={inputId}>
      {field.label}
      {field.type === "long_text" ? (
        <textarea
          id={inputId}
          aria-label={field.label}
          rows={6}
          value={String(value ?? "")}
          required={required}
          maxLength={required ? 160 : 12000}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : field.type === "select" ? (
        <select
          id={inputId}
          aria-label={field.label}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Unsorted</option>
          {field.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={inputId}
          aria-label={field.label}
          type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
          value={String(value ?? "")}
          required={required}
          maxLength={required ? 160 : 12000}
          onChange={(event) =>
            onChange(
              field.type === "number"
                ? event.target.value === ""
                  ? undefined
                  : Number(event.target.value)
                : event.target.value,
            )
          }
        />
      )}
    </label>
  );
}
