import type { MessageRole, TaskStatus } from "@nexestra/core";
import { create } from "zustand";

export type Theme = "dark" | "light";

/** A message typed into the composer during this session (M0 has no backend). */
export interface LocalMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

interface UiState {
  theme: Theme;
  /** Task status overrides produced by dragging cards on the board. */
  taskStatusOverrides: Record<string, TaskStatus>;
  selectedTaskId: string | null;
  selectedMemoryId: string | null;
  openFilePath: string;
  localMessages: LocalMessage[];
  paletteOpen: boolean;
  /** Bumped by ⌘/ so the Chat composer can focus itself. */
  composerFocusNonce: number;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setTaskStatus: (taskId: string, status: TaskStatus) => void;
  selectTask: (taskId: string | null) => void;
  selectMemory: (memoryId: string | null) => void;
  openFile: (path: string) => void;
  appendLocalMessage: (message: LocalMessage) => void;
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
  taskStatusOverrides: {},
  selectedTaskId: null,
  selectedMemoryId: null,
  openFilePath: "src/adapters/codex.ts",
  localMessages: [],
  paletteOpen: false,
  composerFocusNonce: 0,

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  setTaskStatus: (taskId, status) =>
    set((state) => ({ taskStatusOverrides: { ...state.taskStatusOverrides, [taskId]: status } })),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  selectMemory: (selectedMemoryId) => set({ selectedMemoryId }),
  openFile: (openFilePath) => set({ openFilePath }),
  appendLocalMessage: (message) =>
    set((state) => ({ localMessages: [...state.localMessages, message] })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  focusComposer: () => set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
}));
