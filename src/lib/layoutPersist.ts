/**
 * Debounced layout persistence: sidebar width + editor/terminal split.
 * Uses settings store (already backed by Rust JSON file).
 */
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";

const LAYOUT_KEY = "__momoshell_layout_persist_v1__";

type LayoutBag = {
  timer: ReturnType<typeof setTimeout> | null;
  unsubUi: (() => void) | null;
  started: boolean;
};

type GlobalBag = typeof globalThis & {
  [LAYOUT_KEY]?: LayoutBag;
};

const g = globalThis as GlobalBag;

function clampSidebar(w: number): number {
  return Math.min(480, Math.max(180, Math.round(w)));
}

function clampSplit(r: number): number {
  return Math.min(0.65, Math.max(0.2, r));
}

/** Exported for unit tests. */
export function clampLayoutSidebar(w: number): number {
  return clampSidebar(w);
}

/** Exported for unit tests. */
export function clampLayoutSplit(r: number): number {
  return clampSplit(r);
}

function scheduleSave(sidebarWidth: number, editorSplitRatio: number) {
  const state = (g[LAYOUT_KEY] ??= {
    timer: null,
    unsubUi: null,
    started: false,
  });
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    const cur = useSettingsStore.getState().settings;
    const nextW = clampSidebar(sidebarWidth);
    const nextR = clampSplit(editorSplitRatio);
    if (
      cur.sidebarWidth === nextW &&
      Math.abs(cur.editorSplitRatio - nextR) < 0.0001
    ) {
      return;
    }
    void useSettingsStore
      .getState()
      .patch({ sidebarWidth: nextW, editorSplitRatio: nextR })
      .catch(() => {
        /* offline / backend missing */
      });
  }, 400);
}

/** Call once after settings.load() so UI picks up saved layout. */
export function hydrateLayoutFromSettings() {
  const s = useSettingsStore.getState().settings;
  useUiStore.setState({
    sidebarWidth: clampSidebar(s.sidebarWidth ?? 260),
    editorSplitRatio: clampSplit(s.editorSplitRatio ?? 0.55),
  });
}

/** Subscribe to UI layout changes and persist (HMR-safe singleton). */
export function startLayoutPersistence() {
  const state = (g[LAYOUT_KEY] ??= {
    timer: null,
    unsubUi: null,
    started: false,
  });
  if (state.started && state.unsubUi) return;
  state.unsubUi?.();
  state.unsubUi = useUiStore.subscribe((ui, prev) => {
    if (
      ui.sidebarWidth === prev.sidebarWidth &&
      ui.editorSplitRatio === prev.editorSplitRatio
    ) {
      return;
    }
    scheduleSave(ui.sidebarWidth, ui.editorSplitRatio);
  });
  state.started = true;
}
