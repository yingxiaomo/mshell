import { create } from "zustand";
import {
  clearAllCredentials as clearAllCredentialsCmd,
  getSettings,
  saveSettings as saveSettingsCmd,
} from "../lib/tauri";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../types/protocol";
import { chromeMode, isPaletteKey } from "../lib/themes";

function applyChrome(mode: "dark" | "light") {
  const root = document.documentElement;
  if (mode === "light") {
    root.classList.add("theme-light");
    root.classList.remove("theme-dark");
    root.dataset.theme = "light";
  } else {
    root.classList.add("theme-dark");
    root.classList.remove("theme-light");
    root.dataset.theme = "dark";
  }
}

/**
 * Migrate pre-split settings where `theme` held a code palette key
 * (one-dark / dracula / …) instead of chrome mode dark|light.
 */
function normalizeSettings(raw: AppSettings): AppSettings {
  const next: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    ...raw,
    codeTheme: raw.codeTheme || DEFAULT_APP_SETTINGS.codeTheme,
    terminalScrollback:
      typeof raw.terminalScrollback === "number" && raw.terminalScrollback > 0
        ? Math.min(100_000, Math.max(100, raw.terminalScrollback))
        : DEFAULT_APP_SETTINGS.terminalScrollback,
    copyOnSelect: !!raw.copyOnSelect,
    sidebarWidth:
      typeof raw.sidebarWidth === "number" && raw.sidebarWidth > 0
        ? Math.min(480, Math.max(180, Math.round(raw.sidebarWidth)))
        : DEFAULT_APP_SETTINGS.sidebarWidth,
    editorSplitRatio:
      typeof raw.editorSplitRatio === "number" &&
      Number.isFinite(raw.editorSplitRatio)
        ? Math.min(0.65, Math.max(0.2, raw.editorSplitRatio))
        : DEFAULT_APP_SETTINGS.editorSplitRatio,
  };
  if (next.theme !== "dark" && next.theme !== "light") {
    if (isPaletteKey(next.theme)) {
      // Legacy: palette lived in `theme`. Prefer it for codeTheme when still default.
      if (
        !raw.codeTheme ||
        raw.codeTheme === DEFAULT_APP_SETTINGS.codeTheme
      ) {
        next.codeTheme = next.theme;
      }
    }
    next.theme = chromeMode(next.theme);
  }
  if (!isPaletteKey(next.codeTheme)) {
    next.codeTheme = DEFAULT_APP_SETTINGS.codeTheme;
  }
  return next;
}

type SettingsState = {
  settings: AppSettings;
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (next: AppSettings) => Promise<AppSettings>;
  patch: (partial: Partial<AppSettings>) => Promise<AppSettings>;
  clearCredentials: () => Promise<void>;
};

const SETTINGS_KEY = "__momoshell_settings_store__";
type GlobalBag = typeof globalThis & {
  [SETTINGS_KEY]?: ReturnType<typeof createSettingsStore>;
};
const g = globalThis as GlobalBag;

function createSettingsStore() {
  return create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_APP_SETTINGS },
  loaded: false,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const raw = await getSettings();
      const settings = normalizeSettings(raw);
      applyChrome(chromeMode(settings.theme));
      set({ settings, loaded: true, loading: false });
      // Persist migration when legacy palette key still lives in `theme`.
      if (
        raw.theme !== settings.theme ||
        (raw.codeTheme || "") !== settings.codeTheme
      ) {
        void saveSettingsCmd(settings).catch(() => {});
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      applyChrome(chromeMode(DEFAULT_APP_SETTINGS.theme));
      set({
        settings: { ...DEFAULT_APP_SETTINGS },
        loaded: true,
        loading: false,
        error: msg,
      });
    }
  },

  save: async (next) => {
    set({ saving: true, error: null });
    try {
      const normalized = normalizeSettings(next);
      // Optimistic: apply chrome + store draft before round-trip so UI updates immediately.
      applyChrome(chromeMode(normalized.theme));
      set({ settings: normalized });
      const settings = normalizeSettings(await saveSettingsCmd(normalized));
      applyChrome(chromeMode(settings.theme));
      set({ settings, saving: false, loaded: true });
      return settings;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ saving: false, error: msg });
      throw e;
    }
  },

  patch: async (partial) => {
    const next = { ...get().settings, ...partial };
    return get().save(next);
  },

  clearCredentials: async () => {
    set({ error: null });
    try {
      await clearAllCredentialsCmd();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: msg });
      throw e;
    }
  },
  }));
}

export const useSettingsStore: ReturnType<typeof createSettingsStore> =
  g[SETTINGS_KEY] ?? (g[SETTINGS_KEY] = createSettingsStore());
