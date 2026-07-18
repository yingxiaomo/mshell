/**
 * Simple quick commands: note (name) + command body.
 * Stored in localStorage. Click to send into the active terminal.
 */
export type Snippet = {
  id: string;
  /** User-facing label / 备注 */
  name: string;
  /** Command text sent to terminal */
  body: string;
  updatedAt: number;
};

const STORAGE_KEY = "momoshell.snippets.v1";
const STORE_KEY = "__momoshell_snippets_store_v2__";

import { create } from "zustand";
import { useSessionsStore } from "./sessions";
import { encodeTerminalInput } from "../lib/events";
import { terminalWrite } from "../lib/tauri";

type SnippetsState = {
  items: Snippet[];
  loaded: boolean;
  load: () => void;
  save: (items: Snippet[]) => void;
  add: (name: string, body: string) => void;
  remove: (id: string) => void;
  /** Send command to active terminal (always ends with newline). */
  run: (body: string) => Promise<void>;
};

type GlobalBag = typeof globalThis & {
  [STORE_KEY]?: ReturnType<typeof createSnippetsStore>;
};
const g = globalThis as GlobalBag;

function migrate(raw: unknown): Snippet[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const s = item as Partial<Snippet> & { tags?: string[] };
      if (!s || typeof s.id !== "string") return null;
      const name = String(s.name ?? "").trim();
      const body = String(s.body ?? "").trim();
      if (!name || !body) return null;
      return {
        id: s.id,
        name,
        body,
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : Date.now(),
      } satisfies Snippet;
    })
    .filter((x): x is Snippet => x != null);
}

function readStorage(): Snippet[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return migrate(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeStorage(items: Snippet[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

function createSnippetsStore() {
  return create<SnippetsState>((set, get) => ({
    items: [],
    loaded: false,

    load: () => set({ items: readStorage(), loaded: true }),

    save: (items) => {
      writeStorage(items);
      set({ items });
    },

    add: (name, body) => {
      const n = name.trim();
      const b = body.trim();
      if (!n || !b) return;
      const snip: Snippet = {
        id: `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: n,
        body: b.replace(/\r\n/g, "\n"),
        updatedAt: Date.now(),
      };
      get().save([snip, ...get().items]);
    },

    remove: (id) => {
      get().save(get().items.filter((s) => s.id !== id));
    },

    run: async (body) => {
      const { activeSessionId, tabs } = useSessionsStore.getState();
      if (!activeSessionId) throw new Error("没有活动终端");
      const tab = tabs.find((t) => t.sessionId === activeSessionId);
      if (!tab || tab.disconnected) throw new Error("当前会话不可用");
      const text = body.endsWith("\n") ? body : `${body}\n`;
      await terminalWrite(
        tab.sessionId,
        tab.channelId,
        encodeTerminalInput(text),
      );
    },
  }));
}

export const useSnippetsStore: ReturnType<typeof createSnippetsStore> =
  g[STORE_KEY] ?? (g[STORE_KEY] = createSnippetsStore());

if (typeof localStorage !== "undefined") {
  useSnippetsStore.getState().load();
}
