import { create } from "zustand";
import type { SideViewId } from "../types/protocol";

export type EditorFile = {
  sessionId: string;
  remotePath: string;
  name: string;
};

type UiState = {
  activeView: SideViewId;
  setActiveView: (v: SideViewId) => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
  /** Currently open file editor (null = closed). */
  editorFile: EditorFile | null;
  openEditor: (f: EditorFile) => void;
  closeEditor: () => void;
  /** Split ratio (0-1) where 1 = editor takes all space. */
  editorSplitRatio: number;
  setEditorSplitRatio: (r: number) => void;
};

export const useUiStore = create<UiState>((set) => ({
  activeView: "sessions",
  setActiveView: (activeView) => set({ activeView }),
  sidebarWidth: 260,
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
  editorFile: null,
  openEditor: (editorFile) => set({ editorFile, activeView: "files" }),
  closeEditor: () => set({ editorFile: null }),
  editorSplitRatio: 0.55,
  setEditorSplitRatio: (editorSplitRatio) => set({ editorSplitRatio }),
}));
