import { ArrowRight, LayoutDashboard } from "lucide-react";
import type { CustomSurface, CustomSurfaceAction } from "../shared/contracts.js";
import "./CustomSurfaceView.css";

const ACTION_LABELS: Record<CustomSurfaceAction, string> = {
  taskboard: "Open Taskboard",
  knowledge: "Open Knowledge",
  attention: "Open Attention",
  runs: "Open Run history",
  reviews: "Open Needs-work review",
  agents: "Open Agents",
};

export function CustomSurfaceView({
  surface,
  counts,
  onAction,
}: {
  surface: CustomSurface;
  counts?: Partial<Record<CustomSurfaceAction, number>>;
  onAction: (action: CustomSurfaceAction) => void;
}) {
  return (
    <section className="custom-surface-view" aria-label={surface.title}>
      <header className="custom-surface-header">
        <div>
          <p className="eyebrow">WORKSPACE SURFACE</p>
          <h1>{surface.title}</h1>
          {surface.description ? <p className="subtitle">{surface.description}</p> : null}
        </div>
        <LayoutDashboard size={28} aria-hidden="true" />
      </header>
      <div className="custom-surface-grid">
        {surface.cards.map((card) => (
          <article className="custom-surface-card" key={card.id}>
            <h2>{card.title}</h2>
            {card.description ? <p>{card.description}</p> : null}
            {counts?.[card.action] !== undefined ? (
              <span className="custom-surface-card-count">
                {counts[card.action]} matching items
              </span>
            ) : null}
            <button type="button" onClick={() => onAction(card.action)}>
              {ACTION_LABELS[card.action]} <ArrowRight size={15} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
