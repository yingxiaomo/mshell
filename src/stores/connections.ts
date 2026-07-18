import { create } from "zustand";
import type { Connection } from "../types/protocol";
import {
  deleteConnection as deleteConnectionCmd,
  duplicateSshConfigConnection,
  importPuttySessions,
  importSshConfig,
  listConnections,
  saveConnection as saveConnectionCmd,
} from "../lib/tauri";

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
  load: () => Promise<void>;
  save: (
    conn: Connection,
    password?: string,
    passphrase?: string,
  ) => Promise<Connection>;
  remove: (id: string) => Promise<void>;
  duplicateAsLocal: (conn: Connection) => Promise<Connection>;
  importPutty: () => Promise<void>;
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
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
    // Also de-dupe by name against manual entries that share the host alias name.
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

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [items, imported] = await Promise.all([
        listConnections(),
        importSshConfig().catch(() => [] as Connection[]),
      ]);
      set({ items, imported, loading: false });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  save: async (conn, password, passphrase) => {
    const saved = await saveConnectionCmd(conn, password, passphrase);
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
    await deleteConnectionCmd(id);
    set({ items: get().items.filter((c) => c.id !== id) });
  },

  duplicateAsLocal: async (conn) => {
    const saved = await duplicateSshConfigConnection(conn);
    set({ items: [...get().items, saved] });
    return saved;
  },

  importPutty: async () => {
    const conns = await importPuttySessions();
    if (conns.length === 0) return;
    set((s) => {
      const existing = new Set(s.items.map((c) => c.host));
      const newItems = conns.filter((c) => !existing.has(c.host));
      return { items: [...s.items, ...newItems] };
    });
  },
}));
