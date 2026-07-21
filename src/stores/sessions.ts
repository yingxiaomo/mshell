import { create } from "zustand";
import type { SessionOpenResult } from "../types/protocol";
import {
  sessionClose as sessionCloseCmd,
  sessionOpen as sessionOpenCmd,
  sessionReconnect as sessionReconnectCmd,
} from "../lib/tauri";
import { clearTerminalBuffers } from "../lib/events";
import { estimateTerminalGeometry } from "../lib/terminalGeometry";
import { useSettingsStore } from "./settings";
import { useUiStore } from "./ui";

export type TerminalTab = {
  sessionId: string;
  connectionId: string;
  channelId: string;
  name: string;
  disconnected?: boolean;
  reconnecting?: boolean;
  disconnectReason?: string;
  synced?: boolean;
};

type SessionsState = {
  tabs: TerminalTab[];
  activeSessionId: string | null;
  opening: boolean;
  openError: string | null;
  addTab: (result: SessionOpenResult) => void;
  setActive: (sessionId: string) => void;
  closeTab: (sessionId: string) => Promise<void>;
  removeTabLocal: (sessionId: string) => void;
  setOpening: (v: boolean) => void;
  setOpenError: (msg: string | null) => void;
  markDisconnected: (sessionId: string, reason?: string) => void;
  /** Update tab after successful reconnect (new session/channel ids). */
  markConnected: (
    oldSessionId: string,
    newSessionId?: string,
    newChannelId?: string,
    result?: SessionOpenResult,
  ) => void;
  reconnectTab: (sessionId: string) => Promise<void>;
  toggleSync: (sessionId: string) => void;
  getSyncedTargets: (excludeSessionId: string) => TerminalTab[];
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Survive Vite HMR so SessionList / FilesView / TerminalTabs share one store. */
// Bump suffix when store shape / side-effects change so HMR drops stale instances.
const SESSIONS_KEY = "__momoshell_sessions_store_v2__";
const LOOPS_KEY = "__momoshell_reconnect_loops_v2__";

type GlobalBag = typeof globalThis & {
  [SESSIONS_KEY]?: ReturnType<typeof createSessionsStore>;
  [LOOPS_KEY]?: Set<string>;
};

const g = globalThis as GlobalBag;

/** Active auto-reconnect loops keyed by the sessionId at disconnect time. */
const autoReconnectLoops: Set<string> =
  g[LOOPS_KEY] ?? (g[LOOPS_KEY] = new Set<string>());

function createSessionsStore() {
  return create<SessionsState>((set, get) => ({
  tabs: [],
  activeSessionId: null,
  opening: false,
  openError: null,

  addTab: (result) => {
    // Defensive: backend must return camelCase SessionOpenResult.
    const sessionId = result?.sessionId;
    const channelId = result?.terminalChannelId;
    if (!sessionId || !channelId) {
      console.error("[sessions] addTab: invalid SessionOpenResult", result);
      set({
        openError:
          "连接成功但返回数据不完整（缺少 sessionId/channelId），终端标签无法创建。",
      });
      return;
    }
    const tab: TerminalTab = {
      sessionId,
      connectionId: result.connectionId,
      channelId,
      name: result.name || "session",
      disconnected: false,
      reconnecting: false,
    };
    set((s) => ({
      tabs: [...s.tabs.filter((t) => t.sessionId !== tab.sessionId), tab],
      activeSessionId: tab.sessionId,
      openError: null,
    }));
  },

  setActive: (sessionId) => set({ activeSessionId: sessionId }),

  closeTab: async (sessionId) => {
    autoReconnectLoops.delete(sessionId);
    clearTerminalBuffers(sessionId);
    // Editor is bound to a live session — close it with the terminal tab.
    useUiStore.getState().closeEditorForSession(sessionId);
    try {
      await sessionCloseCmd(sessionId);
    } catch {
      // Still remove from UI if backend already gone.
    }
    get().removeTabLocal(sessionId);
  },

  removeTabLocal: (sessionId) => {
    autoReconnectLoops.delete(sessionId);
    clearTerminalBuffers(sessionId);
    useUiStore.getState().closeEditorForSession(sessionId);
    set((s) => {
      const tabs = s.tabs.filter((t) => t.sessionId !== sessionId);
      let activeSessionId = s.activeSessionId;
      if (activeSessionId === sessionId) {
        activeSessionId =
          tabs.length > 0 ? tabs[tabs.length - 1]!.sessionId : null;
      }
      return { tabs, activeSessionId };
    });
  },

  setOpening: (opening) => set({ opening }),
  setOpenError: (openError) => set({ openError }),

  markDisconnected: (sessionId, reason) => {
    const tab = get().tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    // Ignore if already disconnected (avoid restarting loops / duplicate UI).
    if (tab.disconnected) {
      if (reason) {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.sessionId === sessionId
              ? { ...t, disconnectReason: reason }
              : t,
          ),
        }));
      }
      return;
    }

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === sessionId
          ? {
              ...t,
              disconnected: true,
              reconnecting: false,
              disconnectReason: reason ?? t.disconnectReason,
            }
          : t,
      ),
    }));

    if (useSettingsStore.getState().settings.autoReconnect) {
      void runAutoReconnect(sessionId, get);
    }
  },

  markConnected: (oldSessionId, newSessionId, newChannelId, result) => {
    const nextId = result?.sessionId ?? newSessionId ?? oldSessionId;
    if (nextId !== oldSessionId) {
      useUiStore.getState().rebindEditorSession(oldSessionId, nextId);
    }
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.sessionId !== oldSessionId) return t;
        const nextChannel =
          result?.terminalChannelId ?? newChannelId ?? t.channelId;
        return {
          ...t,
          sessionId: nextId,
          channelId: nextChannel,
          connectionId: result?.connectionId ?? t.connectionId,
          name: result?.name ?? t.name,
          disconnected: false,
          reconnecting: false,
          disconnectReason: undefined,
        };
      });
      let activeSessionId = s.activeSessionId;
      if (activeSessionId === oldSessionId) {
        activeSessionId = nextId;
      }
      return { tabs, activeSessionId, openError: null };
    });
    autoReconnectLoops.delete(oldSessionId);
  },

  reconnectTab: async (sessionId) => {
    const tab = get().tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    if (tab.reconnecting) return;

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === sessionId ? { ...t, reconnecting: true } : t,
      ),
    }));

    try {
      let result: SessionOpenResult;
      const { cols, rows } = estimateTerminalGeometry();
      try {
        result = await sessionReconnectCmd(sessionId, cols, rows);
      } catch {
        // Session may already be gone from the manager; open by connection.
        result = await sessionOpenCmd(tab.connectionId, cols, rows);
      }
      // Tab may have been closed while awaiting.
      if (!get().tabs.some((t) => t.sessionId === sessionId)) {
        try {
          await sessionCloseCmd(result.sessionId);
        } catch {
          /* ignore */
        }
        return;
      }
      get().markConnected(
        sessionId,
        result.sessionId,
        result.terminalChannelId,
        result,
      );
    } catch (e) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.sessionId === sessionId
            ? {
                ...t,
                reconnecting: false,
                disconnected: true,
                disconnectReason:
                  e instanceof Error ? e.message : String(e),
              }
            : t,
        ),
      }));
      throw e;
    }
  },

  toggleSync: (sessionId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.sessionId === sessionId ? { ...t, synced: !t.synced } : t,
      ),
    }));
  },

  getSyncedTargets: (excludeSessionId) => {
    return get().tabs.filter(
      (t) => t.synced && t.sessionId !== excludeSessionId,
    );
  },
  }));
}

export const useSessionsStore: ReturnType<typeof createSessionsStore> =
  g[SESSIONS_KEY] ?? (g[SESSIONS_KEY] = createSessionsStore());

async function runAutoReconnect(
  sessionId: string,
  get: () => SessionsState,
) {
  if (autoReconnectLoops.has(sessionId)) return;
  autoReconnectLoops.add(sessionId);

  let delayMs = 1000;
  try {
    while (autoReconnectLoops.has(sessionId)) {
      await sleep(delayMs);
      const tab = get().tabs.find((t) => t.sessionId === sessionId);
      if (!tab || !tab.disconnected) {
        return;
      }
      if (tab.reconnecting) {
        continue;
      }
      try {
        await get().reconnectTab(sessionId);
        return;
      } catch {
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    }
  } finally {
    autoReconnectLoops.delete(sessionId);
  }
}
