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
  /** How many times this command has been executed. */
  usageCount: number;
  /** Timestamp of last execution. */
  lastUsed: number;
};

const STORAGE_KEY = "mshell.snippets.v1";
const STORE_KEY = "__mshell_snippets_store_v2__";

import { create } from "zustand";
import { useSessionsStore } from "./sessions";
import { encodeTerminalInput } from "../lib/events";
import { cmd, commands } from "../lib/commands";

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
        usageCount: typeof (s as any).usageCount === "number" ? (s as any).usageCount : 0,
        lastUsed: typeof (s as any).lastUsed === "number" ? (s as any).lastUsed : 0,
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
        usageCount: 0,
        lastUsed: 0,
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

      // 变量替换
      const hostname = tab.name.split(/[@.\s]/)[0] ?? tab.name;
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, "0");
      const resolved = body
        .replace(/\{hostname\}/g, hostname)
        .replace(/\{date\}/g, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
        .replace(/\{time\}/g, `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`);

      const text = resolved.endsWith("\n") ? resolved : `${resolved}\n`;
      await cmd(commands.terminalWrite, {
        sessionId: tab.sessionId,
        channelId: tab.channelId,
        data: encodeTerminalInput(text),
      });

      // 更新使用统计（按 body 匹配）
      set((s) => {
        const items = s.items.map((snip) =>
          snip.body === body
            ? { ...snip, usageCount: snip.usageCount + 1, lastUsed: Date.now() }
            : snip,
        );
        writeStorage(items);
        return { items };
      });
    },
  }));
}

export const useSnippetsStore: ReturnType<typeof createSnippetsStore> =
  g[STORE_KEY] ?? (g[STORE_KEY] = createSnippetsStore());

if (typeof localStorage !== "undefined") {
  useSnippetsStore.getState().load();
}
