import { Button, Tag } from "@nexestra/ui-kit";
import { useMemories } from "../../lib/api.js";
import { formatDateTime, MEMORY_TYPE_COLOR } from "../../lib/format.js";
import { useUiStore } from "../../lib/store.js";

export function MemorySidebar({ workspaceId }: { workspaceId: string }) {
  const memories = useMemories(workspaceId);
  const selectedMemoryId = useUiStore((state) => state.selectedMemoryId);
  const selectMemory = useUiStore((state) => state.selectMemory);

  const rows = memories.data ?? [];
  const memory = rows.find((item) => item.id === selectedMemoryId);

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

  return (
    <>
      <section className="sidebar__section">
        <div style={{ color: "var(--nx-fg-strong)", marginBottom: 4 }}>{memory.title}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span
            className="graph__legend-swatch"
            style={{ background: MEMORY_TYPE_COLOR[memory.type] }}
          />
          <Tag>{memory.type}</Tag>
          <span className="nx-muted">{memory.authoredBy}</span>
        </div>
      </section>

      <section className="sidebar__section">
        <div className="sidebar__section-title">Content</div>
        <div style={{ color: "var(--nx-fg-dim)", lineHeight: 1.5 }}>{memory.content}</div>
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
                style={{
                  border: 0,
                  background: "transparent",
                  color: "var(--nx-fg-dim)",
                  fontFamily: "inherit",
                  fontSize: 11,
                  textAlign: "left",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                <Tag tone="info">{link.type}</Tag> {target?.title}
              </button>
            </li>
          ))}
          {incoming.map(({ link, source }) => (
            <li key={`in-${link.type}-${source.id}`}>
              <span className="sidebar__bullet">←</span>
              <button
                type="button"
                onClick={() => selectMemory(source.id)}
                style={{
                  border: 0,
                  background: "transparent",
                  color: "var(--nx-fg-dim)",
                  fontFamily: "inherit",
                  fontSize: 11,
                  textAlign: "left",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
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

      <div style={{ display: "flex", gap: 6 }}>
        <Button title="Not wired up in M0">Open source</Button>
        <Button tone="primary" title="Not wired up in M0">
          Edit memory
        </Button>
      </div>
    </>
  );
}
