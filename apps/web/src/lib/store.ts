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
  /** Run the Editor surface is showing. `null` = follow the latest running one. */
  selectedRunId: string | null;
  /** File open in the Editor, relative to the selected run's worktree. */
  openFilePath: string | null;
  /** Editor shows the unified diff instead of the file. */
  diffMode: boolean;
  paletteOpen: boolean;
  /** Bumped by ⌘/ so the Chat composer can focus itself. */
  composerFocusNonce: number;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  selectTask: (taskId: string | null) => void;
  selectMemory: (memoryId: string | null) => void;
  openRun: (runId: string | null) => void;
  openFile: (path: string | null) => void;
  setDiffMode: (on: boolean) => void;
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
  selectedRunId: null,
  openFilePath: null,
  diffMode: false,
  paletteOpen: false,
  composerFocusNonce: 0,

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  selectMemory: (selectedMemoryId) => set({ selectedMemoryId }),
  // A different run means a different worktree, so the open file cannot carry
  // over — the same path may not exist there.
  openRun: (selectedRunId) => set({ selectedRunId, openFilePath: null, diffMode: false }),
  openFile: (openFilePath) => set({ openFilePath, diffMode: false }),
  setDiffMode: (diffMode) => set({ diffMode }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  focusComposer: () => set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
}));
