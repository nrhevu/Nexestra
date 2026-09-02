import { type MemoryType, MemoryTypeSchema } from "@nexestra/core";
import { Button, Select, Tag, TextInput } from "@nexestra/ui-kit";
import { useState } from "react";
import { useMemories, useUpdateMemory } from "../../lib/api.js";
import { formatDateTime, MEMORY_TYPE_COLOR } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";

const TYPE_OPTIONS = MemoryTypeSchema.options.map((type) => ({ value: type, label: type }));

export function MemorySidebar({ workspaceId }: { workspaceId: string }) {
  const memories = useMemories(workspaceId);
  const updateMemory = useUpdateMemory(workspaceId);
  const selectedMemoryId = useUiStore((state) => state.selectedMemoryId);
  const selectMemory = useUiStore((state) => state.selectMemory);

  const rows = memories.data ?? [];
  const memory = rows.find((item) => item.id === selectedMemoryId);

  // The draft only exists while editing, and is seeded when edit mode opens —
  // no effect has to keep it in sync with the selected node.
  const [draft, setDraft] = useState<{ id: string; title: string; content: string } | null>(null);
  const editing = draft !== null && draft.id === memory?.id;

  if (!memory) {
    return (
      <div className="nx-muted">
        Click a node to inspect it. {rows.length} memories in this workspace.
      </div>
    );
  }

  const outgoing = memory.links
    .map((link) => ({ link, target: rows.find((item) => item.id === link.targetId) }))
    .filter((entry) => entry.target);

  const incoming = rows.flatMap((candidate) =>
    candidate.links
      .filter((link) => link.targetId === memory.id)
      .map((link) => ({ link, source: candidate })),
  );

  const save = () => {
    if (!draft) return;
    updateMemory.mutate(
      {
        memoryId: memory.id,
        patch: { title: draft.title.trim() || memory.title, content: draft.content },
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <>
      <section className="sidebar__section">
        {editing ? (
          <TextInput
            id="memory-title"
            label="Title"
            value={draft.title}
            onChange={(event) =>
              setDraft((current) => (current ? { ...current, title: event.target.value } : current))
            }
          />
        ) : (
          <div style={{ color: "var(--nx-fg-strong)", marginBottom: 4 }}>{memory.title}</div>
        )}
        <div className="row">
          <span
            className="graph__legend-swatch"
            style={{ background: MEMORY_TYPE_COLOR[memory.type] }}
          />
          {editing ? (
            <Select
              id="memory-type"
              value={memory.type}
              options={TYPE_OPTIONS}
              onChange={(event) =>
                updateMemory.mutate({
                  memoryId: memory.id,
                  patch: { type: event.target.value as MemoryType },
                })
              }
            />
          ) : (
            <Tag>{memory.type}</Tag>
          )}
          <span className="nx-muted">{memory.authoredBy}</span>
        </div>
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Content</div>
        {editing ? (
          <textarea
            className="nx-textarea"
            rows={6}
            value={draft.content}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, content: event.target.value } : current,
              )
            }
          />
        ) : (
          <div style={{ color: "var(--nx-fg-dim)", lineHeight: 1.5 }}>{memory.content}</div>
        )}
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Linked memories</div>
        <ul className="sidebar__list">
          {outgoing.map(({ link, target }) => (
            <li key={`out-${link.type}-${link.targetId}`}>
              <span className="sidebar__bullet">→</span>
              <button
                type="button"
                onClick={() => selectMemory(link.targetId)}
                className="link-button"
              >
                <Tag tone="info">{link.type}</Tag> {target?.title}
              </button>
            </li>
          ))}
          {incoming.map(({ link, source }) => (
            <li key={`in-${link.type}-${source.id}`}>
              <span className="sidebar__bullet">←</span>
              <button type="button" onClick={() => selectMemory(source.id)} className="link-button">
                <Tag>{link.type}</Tag> {source.title}
              </button>
            </li>
          ))}
          {outgoing.length + incoming.length === 0 ? <li className="nx-muted">no links</li> : null}
        </ul>
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Source</div>
        <div className="kv">
          <span className="kv__k">kind</span>
          <span className="kv__v">{memory.source?.kind ?? "—"}</span>
          <span className="kv__k">label</span>
          <span className="kv__v">{memory.source?.label ?? "—"}</span>
          <span className="kv__k">updated</span>
          <span className="kv__v">{formatDateTime(memory.updatedAt)}</span>
        </div>
      </section>

      {updateMemory.isError ? <div className="form-error">{updateMemory.error.message}</div> : null}

      <div className="row">
        <Button title="Jumping to the source lands with the Master in M2" disabled>
          Open source
        </Button>
        {editing ? (
          <>
            <Button tone="primary" onClick={save} disabled={updateMemory.isPending}>
              {updateMemory.isPending ? "Saving…" : "Save"}
            </Button>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
          </>
        ) : (
          <Button
            tone="primary"
            onClick={() =>
              setDraft({ id: memory.id, title: memory.title, content: memory.content })
            }
          >
            Edit memory
          </Button>
        )}
      </div>
    </>
  );
}
