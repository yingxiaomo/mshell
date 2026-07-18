import { create } from "zustand";
import type { SessionOpenResult } from "../types/protocol";
import {
  sessionClose as sessionCloseCmd,
  sessionOpen as sessionOpenCmd,
  sessionReconnect as sessionReconnectCmd,
} from "../lib/tauri";
import { useSettingsStore } from "./settings";

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

/** Active auto-reconnect loops keyed by the sessionId at disconnect time. */
const autoReconnectLoops = new Set<string>();

export const useSessionsStore = create<SessionsState>((set, get) => ({
  tabs: [],
  activeSessionId: null,
  opening: false,
  openError: null,

  addTab: (result) => {
    const tab: TerminalTab = {
      sessionId: result.sessionId,
      connectionId: result.connectionId,
      channelId: result.terminalChannelId,
      name: result.name,
      disconnected: false,
      reconnecting: false,
    };
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeSessionId: tab.sessionId,
      openError: null,
    }));
  },

  setActive: (sessionId) => set({ activeSessionId: sessionId }),

  closeTab: async (sessionId) => {
    autoReconnectLoops.delete(sessionId);
    try {
      await sessionCloseCmd(sessionId);
    } catch {
      // Still remove from UI if backend already gone.
    }
    get().removeTabLocal(sessionId);
  },

  removeTabLocal: (sessionId) => {
    autoReconnectLoops.delete(sessionId);
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
    set((s) => {
      const tabs = s.tabs.map((t) => {
        if (t.sessionId !== oldSessionId) return t;
        const nextId = result?.sessionId ?? newSessionId ?? t.sessionId;
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
        activeSessionId =
          result?.sessionId ?? newSessionId ?? activeSessionId;
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
      try {
        result = await sessionReconnectCmd(sessionId);
      } catch {
        // Session may already be gone from the manager; open by connection.
        result = await sessionOpenCmd(tab.connectionId);
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
