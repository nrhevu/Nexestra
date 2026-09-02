import { create } from "zustand";

export type Theme = "dark" | "light";

/**
 * Session-only UI state. Everything that outlives a reload now lives in the
 * server's SQLite store, so this is selection, focus and theme only.
 */
interface UiState {
  theme: Theme;
  selectedTaskId: string | null;
  selectedMemoryId: string | null;
  openFilePath: string;
  paletteOpen: boolean;
  /** Bumped by ⌘/ so the Chat composer can focus itself. */
  composerFocusNonce: number;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  selectTask: (taskId: string | null) => void;
  selectMemory: (memoryId: string | null) => void;
  openFile: (path: string) => void;
  setPaletteOpen: (open: boolean) => void;
  focusComposer: () => void;
}

const THEME_KEY = "nexestra.theme";

function readStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "dark";
  return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, theme);
}

export const useUiStore = create<UiState>()((set, get) => ({
  theme: readStoredTheme(),
  selectedTaskId: null,
  selectedMemoryId: null,
  openFilePath: "src/adapters/codex.ts",
  paletteOpen: false,
  composerFocusNonce: 0,

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  selectMemory: (selectedMemoryId) => set({ selectedMemoryId }),
  openFile: (openFilePath) => set({ openFilePath }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  focusComposer: () => set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
}));
