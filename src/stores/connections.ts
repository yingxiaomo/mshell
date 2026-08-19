import { create } from "zustand";
import type { Connection } from "../types/protocol";
import { cmd, commands } from "../lib/commands";

function isSshConfigSource(c: Connection): boolean {
  return c.source?.type === "sshConfig";
}

interface ConnectionsState {
  /** Local (persisted) connections only. */
  items: Connection[];
  /** Imported from ~/.ssh/config; not written until duplicated. */
  imported: Connection[];
  loading: boolean;
  error: string | null;
  /** Merged list: local first, then imported (skip alias already present as local). */
  all: () => Connection[];
  /** Local connections with lastConnected, newest first (max n). */
  recents: (n?: number) => Connection[];
  load: () => Promise<void>;
  /** Soft reload without clearing UI (e.g. after session open stamps lastConnected). */
  reloadQuiet: () => Promise<void>;
  save: (
    conn: Connection,
    password?: string,
    passphrase?: string,
  ) => Promise<Connection>;
  remove: (id: string) => Promise<void>;
  duplicateAsLocal: (conn: Connection) => Promise<Connection>;
  importPutty: () => Promise<void>;
}

const CONNECTIONS_KEY = "__mshell_connections_store_v1__";
type GlobalBag = typeof globalThis & {
  [CONNECTIONS_KEY]?: ReturnType<typeof createConnectionsStore>;
};
const g = globalThis as GlobalBag;

function createConnectionsStore() {
  return create<ConnectionsState>((set, get) => ({
  items: [],
  imported: [],
  loading: false,
  error: null,

  all: () => {
    const { items, imported } = get();
    const localAliases = new Set(
      items
        .filter(isSshConfigSource)
        .map((c) =>
          c.source.type === "sshConfig" ? c.source.hostAlias : c.name,
        ),
    );
    const localNames = new Set(items.map((c) => c.name));
    const extra = imported.filter(
      (c) =>
        !(
          c.source.type === "sshConfig" &&
          (localAliases.has(c.source.hostAlias) || localNames.has(c.name))
        ),
    );
    return [...items, ...extra];
  },

  recents: (n = 5) => {
    return get()
      .items
      .filter((c) => !!c.lastConnected)
      .slice()
      .sort((a, b) => {
        const ta = a.lastConnected ? Date.parse(a.lastConnected) : 0;
        const tb = b.lastConnected ? Date.parse(b.lastConnected) : 0;
        return tb - ta;
      })
      .slice(0, n);
  },

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [items, imported] = await Promise.all([
        cmd(commands.listConnections),
        cmd(commands.importSshConfig).catch(() => [] as Connection[]),
      ]);
      set({ items, imported, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  reloadQuiet: async () => {
    try {
      const items = await cmd(commands.listConnections);
      set({ items });
    } catch {
      /* ignore soft reload errors */
    }
  },

  save: async (conn, password, passphrase) => {
    const saved = await cmd(commands.saveConnection, { conn, password: password ?? null, passphrase: passphrase ?? null });
    const items = get().items;
    const idx = items.findIndex((c) => c.id === saved.id);
    if (idx >= 0) {
      const next = items.slice();
      next[idx] = saved;
      set({ items: next });
    } else {
      set({ items: [...items, saved] });
    }
    return saved;
  },

  remove: async (id) => {
    await cmd(commands.deleteConnection, { id });
    set({ items: get().items.filter((c) => c.id !== id) });
  },

  duplicateAsLocal: async (conn) => {
    const saved = await cmd(commands.duplicateSshConfigConnection, { conn });
    set({ items: [...get().items, saved] });
    return saved;
  },

  importPutty: async () => {
    const conns = await cmd(commands.importPuttySessions);
    if (conns.length === 0) return;
    set((s) => {
      const existing = new Set(s.items.map((c) => c.host));
      const newItems = conns.filter((c) => !existing.has(c.host));
      return { items: [...s.items, ...newItems] };
    });
  },
  }));
}

export const useConnectionsStore: ReturnType<typeof createConnectionsStore> =
  g[CONNECTIONS_KEY] ?? (g[CONNECTIONS_KEY] = createConnectionsStore());
