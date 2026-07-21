import { create } from "zustand";
import type { SideViewId } from "../types/protocol";

export type EditorTab = {
  /** Stable id: `${sessionId}::${remotePath}` */
  id: string;
  sessionId: string;
  remotePath: string;
  name: string;
  dirty?: boolean;
};

/** @deprecated Use EditorTab — kept for call-site typing during migration. */
export type EditorFile = Omit<EditorTab, "id" | "dirty">;

export function editorTabId(sessionId: string, remotePath: string): string {
  return `${sessionId}::${remotePath}`;
}

type UiState = {
  activeView: SideViewId;
  setActiveView: (v: SideViewId) => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;

  /** Open editor tabs (multi-file). */
  editorTabs: EditorTab[];
  activeEditorId: string | null;
  /** Open or focus a file tab. Same path re-focuses existing tab. */
  openEditor: (f: EditorFile) => void;
  setActiveEditor: (id: string) => void;
  /** Close one editor tab by id. */
  closeEditorTab: (id: string) => void;
  /** Close the active editor tab (toolbar X). */
  closeEditor: () => void;
  /** Close all editor tabs for a session (terminal tab closed). */
  closeEditorForSession: (sessionId: string) => void;
  /** Remap editor session ids after reconnect. */
  rebindEditorSession: (oldSessionId: string, newSessionId: string) => void;
  setEditorDirty: (id: string, dirty: boolean) => void;

  /** Split ratio (0-1) for editor pane height share. */
  editorSplitRatio: number;
  setEditorSplitRatio: (r: number) => void;

  /** Command palette (Ctrl+P / Ctrl+Shift+P). */
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;
};

// Bump when store shape changes so HMR drops stale singletons.
const UI_KEY = "__momoshell_ui_store_v4__";
type GlobalBag = typeof globalThis & {
  [UI_KEY]?: ReturnType<typeof createUiStore>;
};
const g = globalThis as GlobalBag;

function createUiStore() {
  return create<UiState>((set, get) => ({
    activeView: "sessions",
    setActiveView: (activeView) => {
      // Drop removed sidebar views (e.g. old "snippets")
      const ok =
        activeView === "sessions" ||
        activeView === "files" ||
        activeView === "tunnels" ||
        activeView === "settings";
      set({ activeView: ok ? activeView : "sessions" });
    },
    sidebarWidth: 260,
    setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),

    editorTabs: [],
    activeEditorId: null,

    openEditor: (f) => {
      const id = editorTabId(f.sessionId, f.remotePath);
      set((s) => {
        const exists = s.editorTabs.some((t) => t.id === id);
        const editorTabs = exists
          ? s.editorTabs
          : [
              ...s.editorTabs,
              {
                id,
                sessionId: f.sessionId,
                remotePath: f.remotePath,
                name: f.name,
                dirty: false,
              },
            ];
        return {
          editorTabs,
          activeEditorId: id,
          activeView: "files" as SideViewId,
        };
      });
    },

    setActiveEditor: (id) => {
      if (!get().editorTabs.some((t) => t.id === id)) return;
      set({ activeEditorId: id });
    },

    closeEditorTab: (id) => {
      set((s) => {
        const tab = s.editorTabs.find((t) => t.id === id);
        if (tab?.dirty) {
          const ok = window.confirm(
            `「${tab.name}」有未保存的更改，确定关闭？`,
          );
          if (!ok) return s;
        }
        const editorTabs = s.editorTabs.filter((t) => t.id !== id);
        let activeEditorId = s.activeEditorId;
        if (activeEditorId === id) {
          activeEditorId =
            editorTabs.length > 0
              ? editorTabs[editorTabs.length - 1]!.id
              : null;
        }
        return { editorTabs, activeEditorId };
      });
    },

    closeEditor: () => {
      const id = get().activeEditorId;
      if (id) get().closeEditorTab(id);
    },

    closeEditorForSession: (sessionId) => {
      set((s) => {
        const remaining = s.editorTabs.filter((t) => t.sessionId !== sessionId);
        // Skip dirty confirm when session is gone — file can no longer be saved.
        let activeEditorId = s.activeEditorId;
        if (
          activeEditorId &&
          s.editorTabs.some(
            (t) => t.id === activeEditorId && t.sessionId === sessionId,
          )
        ) {
          activeEditorId =
            remaining.length > 0
              ? remaining[remaining.length - 1]!.id
              : null;
        }
        return { editorTabs: remaining, activeEditorId };
      });
    },

    rebindEditorSession: (oldSessionId, newSessionId) => {
      set((s) => {
        const editorTabs = s.editorTabs.map((t) => {
          if (t.sessionId !== oldSessionId) return t;
          const id = editorTabId(newSessionId, t.remotePath);
          return { ...t, id, sessionId: newSessionId };
        });
        let activeEditorId = s.activeEditorId;
        if (activeEditorId) {
          const old = s.editorTabs.find((t) => t.id === activeEditorId);
          if (old?.sessionId === oldSessionId) {
            activeEditorId = editorTabId(newSessionId, old.remotePath);
          }
        }
        return { editorTabs, activeEditorId };
      });
    },

    setEditorDirty: (id, dirty) => {
      set((s) => {
        const tab = s.editorTabs.find((t) => t.id === id);
        if (!tab || tab.dirty === dirty) return s; // no-op if unchanged
        return {
          editorTabs: s.editorTabs.map((t) =>
            t.id === id ? { ...t, dirty } : t,
          ),
        };
      });
    },

    editorSplitRatio: 0.55,
    setEditorSplitRatio: (editorSplitRatio) =>
      set({
        editorSplitRatio: Math.max(0.2, Math.min(0.65, editorSplitRatio)),
      }),

    commandPaletteOpen: false,
    setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  }));
}

export const useUiStore: ReturnType<typeof createUiStore> =
  g[UI_KEY] ?? (g[UI_KEY] = createUiStore());
