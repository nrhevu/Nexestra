import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useUiStore } from "../lib/store.js";
import { SURFACE_ROUTES, SURFACES } from "./surfaces.js";

export interface ShellKeyboardTarget {
  workspaceId: string;
  threadId: string;
}

/**
 * ⌘1..⌘4 switch surface, ⌘/ focuses the composer, ⌘K opens the palette,
 * ⌘, opens Settings (PLAN.md §7).
 */
export function useShellKeyboard({ workspaceId, threadId }: ShellKeyboardTarget): void {
  const navigate = useNavigate();
  const focusComposer = useUiStore((state) => state.focusComposer);
  const setPaletteOpen = useUiStore((state) => state.setPaletteOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      const index = Number.parseInt(event.key, 10);
      if (index >= 1 && index <= SURFACES.length) {
        const surface = SURFACES[index - 1];
        if (!surface) return;
        event.preventDefault();
        void navigate({ to: SURFACE_ROUTES[surface.id], params: { workspaceId, threadId } });
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        void navigate({ to: SURFACE_ROUTES.chat, params: { workspaceId, threadId } }).then(() =>
          focusComposer(),
        );
        return;
      }

      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (event.key === ",") {
        event.preventDefault();
        void navigate({ to: "/settings" });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, workspaceId, threadId, focusComposer, setPaletteOpen]);
}
