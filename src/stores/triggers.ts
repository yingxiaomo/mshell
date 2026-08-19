/**
 * Terminal trigger rules: when a regex matches live terminal output, raise an
 * alert (toast + bell). Stored in localStorage. Useful for spotting
 * "error"/"panic"/"OOM"/… in log streams without watching the screen.
 */
export type Trigger = {
  id: string;
  /** User-facing label */
  name: string;
  /** Regex source (tested case-insensitively). */
  pattern: string;
  enabled: boolean;
  updatedAt: number;
};

const STORAGE_KEY = "mshell.triggers.v1";
const STORE_KEY = "__mshell_triggers_store_v1__";

import { create } from "zustand";

type TriggersState = {
  items: Trigger[];
  loaded: boolean;
  load: () => void;
  add: (name: string, pattern: string) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
};

type GlobalBag = typeof globalThis & {
  [STORE_KEY]?: ReturnType<typeof createTriggersStore>;
};
const g = globalThis as GlobalBag;

function migrate(raw: unknown): Trigger[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const t = item as Partial<Trigger>;
      if (!t || typeof t.id !== "string") return null;
      const name = String(t.name ?? "").trim();
      const pattern = String(t.pattern ?? "");
      if (!name || !pattern) return null;
      return {
        id: t.id,
        name,
        pattern,
        enabled: t.enabled !== false,
        updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : Date.now(),
      } satisfies Trigger;
    })
    .filter((x): x is Trigger => x != null);
}

function readStorage(): Trigger[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return migrate(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeStorage(items: Trigger[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

/** Validate a regex source; returns an error message or null. */
export function validateTriggerPattern(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "无效的正则";
  }
}

function createTriggersStore() {
  return create<TriggersState>((set, get) => ({
    items: [],
    loaded: false,

    load: () => set({ items: readStorage(), loaded: true }),

    add: (name, pattern) => {
      const n = name.trim();
      const p = pattern;
      if (!n || !p || validateTriggerPattern(p)) return;
      const t: Trigger = {
        id: `trg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: n,
        pattern: p,
        enabled: true,
        updatedAt: Date.now(),
      };
      const items = [t, ...get().items];
      writeStorage(items);
      set({ items });
    },

    remove: (id) => {
      const items = get().items.filter((t) => t.id !== id);
      writeStorage(items);
      set({ items });
    },

    toggle: (id) => {
      const items = get().items.map((t) =>
        t.id === id ? { ...t, enabled: !t.enabled, updatedAt: Date.now() } : t,
      );
      writeStorage(items);
      set({ items });
    },
  }));
}

export const useTriggersStore: ReturnType<typeof createTriggersStore> =
  g[STORE_KEY] ?? (g[STORE_KEY] = createTriggersStore());

if (typeof localStorage !== "undefined") {
  useTriggersStore.getState().load();
}
