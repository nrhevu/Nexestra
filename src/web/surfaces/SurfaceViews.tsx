import { Check, GripHorizontal, Pencil, Plus, Square } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type {
  SaveSurfaceRecordInput,
  SurfaceRecord,
  WorkspaceSurface,
} from "../../shared/surfaces.js";

const RichMessage = lazy(() => import("../RichMessage.js"));
type Props = {
  surface: WorkspaceSurface;
  selection: string[];
  working: boolean;
  onSelect: (id: string) => void;
  onEdit: (record: SurfaceRecord) => void;
  onCreate: (group?: string) => void;
  onSave: (record: SurfaceRecord, patch: Partial<SaveSurfaceRecordInput>) => Promise<void>;
};

export function SurfaceView(props: Props) {
  const { surface, working, onEdit, onCreate, onSave } = props;
  const records = surface.records.filter((record) => !record.archived);
  const { manifest } = surface;
  const editable = surface.enabled && !working;
  if (manifest.view === "canvas") return <CanvasView {...props} />;
  if (manifest.view === "board") {
    const grouping = manifest.fields.find((field) => field.key === manifest.groupBy);
    const groups = [...(grouping?.options ?? []), ""];
    return (
      <div className="studio-board">
        {groups.map((group) => {
          const grouped = records.filter(
            (record) => String(record.data[manifest.groupBy ?? ""] || "") === group,
          );
          const label = group || "Unsorted";
          return (
            <section
              key={group}
              className="studio-board-column"
              aria-label={`${label} column`}
              onDragOver={(event) => {
                if (editable) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!editable || !manifest.groupBy) return;
                const record = records.find(
                  (entry) => entry.id === event.dataTransfer.getData("text/plain"),
                );
                if (record)
                  void onSave(record, { data: { ...record.data, [manifest.groupBy]: group } });
              }}
            >
              <header>
                <h3>{label}</h3>
                <small>{grouped.length}</small>
                <button
                  type="button"
                  aria-label={`Add to ${label}`}
                  disabled={!editable}
                  onClick={() => onCreate(group)}
                >
                  <Plus size={14} />
                </button>
              </header>
              {grouped.map((record) => (
                <article
                  className={`studio-card note-${record.color}`}
                  key={record.id}
                  draggable={editable}
                  onDragStart={(event) => event.dataTransfer.setData("text/plain", record.id)}
                >
                  <RecordSelection {...props} record={record} />
                  <button
                    type="button"
                    className="studio-card-copy"
                    disabled={!editable}
                    onClick={() => onEdit(record)}
                  >
                    <strong>{String(record.data[manifest.titleField])}</strong>
                    <p>{String(record.data[manifest.bodyField ?? ""] ?? "")}</p>
                  </button>
                </article>
              ))}
              {grouped.length === 0 && <p className="studio-column-empty">Drop an idea here</p>}
            </section>
          );
        })}
      </div>
    );
  }
  if (records.length === 0)
    return (
      <div className="studio-empty compact">
        <h3>Start with one useful record</h3>
        <p>Add an idea, a source, a finding or a decision.</p>
        <button type="button" disabled={!editable} onClick={() => onCreate()}>
          <Plus size={15} /> Add record
        </button>
      </div>
    );
  if (manifest.view === "document")
    return (
      <div className="studio-documents">
        {records.map((record) => (
          <article key={record.id} className="studio-document">
            <header>
              <RecordSelection {...props} record={record} />
              <h3>{String(record.data[manifest.titleField])}</h3>
              <button
                type="button"
                disabled={!editable}
                aria-label={`Edit ${String(record.data[manifest.titleField])}`}
                onClick={() => onEdit(record)}
              >
                <Pencil size={15} /> Edit
              </button>
            </header>
            <Suspense fallback={<p>{String(record.data[manifest.bodyField ?? ""] ?? "")}</p>}>
              <RichMessage
                content={String(record.data[manifest.bodyField ?? ""] ?? "")}
                knownHandles={new Set()}
              />
            </Suspense>
            {manifest.fields
              .filter(
                (field) => field.key !== manifest.titleField && field.key !== manifest.bodyField,
              )
              .map((field) =>
                record.data[field.key] === undefined || record.data[field.key] === "" ? null : (
                  <p className="studio-document-meta" key={field.key}>
                    <strong>{field.label}: </strong>
                    <FieldValue type={field.type} value={record.data[field.key]} />
                  </p>
                ),
              )}
          </article>
        ))}
      </div>
    );
  return (
    <div className="studio-table-wrap">
      <table className="studio-table">
        <thead>
          <tr>
            <th scope="col">Select</th>
            {manifest.fields.map((field) => (
              <th scope="col" key={field.key}>
                {field.label}
              </th>
            ))}
            <th scope="col">Edit</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              <td>
                <RecordSelection {...props} record={record} />
              </td>
              {manifest.fields.map((field) => (
                <td key={field.key}>
                  <FieldValue type={field.type} value={record.data[field.key]} />
                </td>
              ))}
              <td>
                <button
                  type="button"
                  aria-label={`Edit ${String(record.data[manifest.titleField])}`}
                  disabled={!editable}
                  onClick={() => onEdit(record)}
                >
                  <Pencil size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldValue({
  type,
  value,
}: {
  type: string;
  value: SurfaceRecord["data"][string] | undefined;
}) {
  if (value === undefined || value === "") return <span className="studio-value-empty">—</span>;
  if (type === "checkbox") return <span>{value ? "Yes" : "No"}</span>;
  if (type === "url")
    return (
      <a href={String(value)} target="_blank" rel="noreferrer">
        {String(value)}
      </a>
    );
  return <span>{String(value)}</span>;
}

function RecordSelection({
  record,
  surface,
  selection,
  onSelect,
}: Props & { record: SurfaceRecord }) {
  const selected = selection.includes(record.id);
  return (
    <button
      className="studio-record-selection"
      type="button"
      aria-label={`Select ${String(record.data[surface.manifest.titleField])}`}
      aria-pressed={selected}
      onClick={() => onSelect(record.id)}
    >
      {selected ? <Check size={14} /> : <Square size={14} />}
    </button>
  );
}

function CanvasView(props: Props) {
  const { surface, working, onEdit, onSave, onCreate } = props;
  const [drag, setDrag] = useState<{
    id: string;
    clientX: number;
    clientY: number;
    originX: number;
    originY: number;
    x: number;
    y: number;
  }>();
  const records = surface.records.filter((record) => !record.archived);
  const editable = surface.enabled && !working;
  return (
    <section className="studio-canvas-scroll" aria-label="Whiteboard canvas">
      <div className="studio-canvas">
        {records.length === 0 && (
          <div className="studio-canvas-empty">
            <h3>Make room for an idea</h3>
            <p>Add notes, arrange them, and select a few to share with your agent.</p>
            <button type="button" disabled={!editable} onClick={() => onCreate()}>
              <Plus size={15} /> Add your first note
            </button>
          </div>
        )}
        {records.map((record) => {
          const position = drag?.id === record.id ? drag : record.position;
          const title = String(record.data[surface.manifest.titleField]);
          return (
            <article
              key={record.id}
              className={`studio-canvas-note note-${record.color}${drag?.id === record.id ? " dragging" : ""}`}
              style={{ left: position.x, top: position.y }}
            >
              <div className="studio-note-bar">
                <RecordSelection {...props} record={record} />
                <button
                  type="button"
                  className="studio-note-grip"
                  aria-label={`Move ${title}`}
                  disabled={!editable}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDrag({
                      id: record.id,
                      clientX: event.clientX,
                      clientY: event.clientY,
                      originX: record.position.x,
                      originY: record.position.y,
                      ...record.position,
                    });
                  }}
                  onPointerMove={(event) => {
                    if (drag?.id !== record.id) return;
                    setDrag({
                      ...drag,
                      x: Math.max(0, Math.min(2000, drag.originX + event.clientX - drag.clientX)),
                      y: Math.max(0, Math.min(1600, drag.originY + event.clientY - drag.clientY)),
                    });
                  }}
                  onPointerUp={() => {
                    if (drag?.id !== record.id) return;
                    if (drag.x !== drag.originX || drag.y !== drag.originY)
                      void onSave(record, { position: { x: drag.x, y: drag.y } });
                    setDrag(undefined);
                  }}
                  onPointerCancel={() => setDrag(undefined)}
                >
                  <GripHorizontal size={17} />
                </button>
              </div>
              <button
                type="button"
                className="studio-card-copy"
                disabled={!editable}
                onClick={() => onEdit(record)}
              >
                <strong>{title}</strong>
                <p>{String(record.data[surface.manifest.bodyField ?? ""] ?? "")}</p>
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
