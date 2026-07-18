import { create } from "zustand";
import {
  clearAllCredentials as clearAllCredentialsCmd,
  getSettings,
  saveSettings as saveSettingsCmd,
} from "../lib/tauri";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "../types/protocol";

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "light") {
    root.classList.add("theme-light");
    root.classList.remove("theme-dark");
    root.dataset.theme = "light";
  } else {
    root.classList.add("theme-dark");
    root.classList.remove("theme-light");
    root.dataset.theme = "dark";
  }
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: { ...DEFAULT_APP_SETTINGS },
  loaded: false,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const settings = await getSettings();
      applyTheme(settings.theme);
      set({ settings, loaded: true, loading: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fall back to defaults so UI still works offline / without backend.
      applyTheme(DEFAULT_APP_SETTINGS.theme);
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
      const settings = await saveSettingsCmd(next);
      applyTheme(settings.theme);
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
