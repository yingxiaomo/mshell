import { create } from "zustand";
import type { Connection } from "../types/protocol";
import {
  deleteConnection as deleteConnectionCmd,
  listConnections,
  saveConnection as saveConnectionCmd,
} from "../lib/tauri";

interface ConnectionsState {
  items: Connection[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (
    conn: Connection,
    password?: string,
    passphrase?: string,
  ) => Promise<Connection>;
  remove: (id: string) => Promise<void>;
}

export const useConnectionsStore = create<ConnectionsState>((set, get) => ({
  items: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const items = await listConnections();
      set({ items, loading: false });
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
}));
