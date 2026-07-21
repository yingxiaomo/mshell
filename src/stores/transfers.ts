import { create } from "zustand";
import type { TransferProgressEvent, TransferStatus } from "../types/protocol";
import {
  sftpDownload,
  sftpUpload,
  transferCancel as transferCancelCmd,
} from "../lib/tauri";

export type TransferDirection = "upload" | "download";

export type TransferItem = {
  transferId: string;
  direction: TransferDirection;
  /** Display label (file name or remote path basename). */
  label: string;
  localPath: string;
  remotePath: string;
  sessionId?: string;
  bytes: number;
  total: number | null;
  status: TransferStatus;
  error?: string | null;
  /** Epoch ms when enqueued. */
  startedAt: number;
};

type TransfersState = {
  items: TransferItem[];
  begin: (
    item: Omit<
      TransferItem,
      "bytes" | "total" | "status" | "startedAt" | "error"
    > & { transferId: string },
  ) => void;
  applyProgress: (ev: TransferProgressEvent) => void;
  cancel: (transferId: string) => Promise<void>;
  cancelAll: () => Promise<void>;
  retry: (transferId: string) => Promise<void>;
  clearFinished: () => void;
  remove: (transferId: string) => void;
};

const TRANSFERS_KEY = "__momoshell_transfers_store_v1__";
type GlobalBag = typeof globalThis & {
  [TRANSFERS_KEY]?: ReturnType<typeof createTransfersStore>;
};
const g = globalThis as GlobalBag;

function createTransfersStore() {
  return create<TransfersState>((set, get) => ({
    items: [],

    begin: (item) => {
      const row: TransferItem = {
        ...item,
        bytes: 0,
        total: null,
        status: "running",
        error: null,
        startedAt: Date.now(),
      };
      set((s) => ({ items: [row, ...s.items] }));
    },

    applyProgress: (ev) => {
      const status = normalizeStatus(ev.status);
      set((s) => {
        const idx = s.items.findIndex((t) => t.transferId === ev.transferId);
        if (idx < 0) {
          const stub: TransferItem = {
            transferId: ev.transferId,
            direction: "download",
            label: ev.transferId.slice(0, 8),
            localPath: "",
            remotePath: "",
            bytes: ev.bytes,
            total: ev.total ?? null,
            status,
            error: ev.error ?? null,
            startedAt: Date.now(),
          };
          return { items: [stub, ...s.items] };
        }
        return {
          items: s.items.map((t) =>
            t.transferId === ev.transferId
              ? {
                  ...t,
                  bytes: ev.bytes,
                  total: ev.total ?? t.total,
                  status,
                  error: ev.error ?? t.error,
                }
              : t,
          ),
        };
      });
    },

    cancel: async (transferId) => {
      try {
        await transferCancelCmd(transferId);
      } catch {
        /* already finished */
      }
      set((s) => ({
        items: s.items.map((t) =>
          t.transferId === transferId && t.status === "running"
            ? { ...t, status: "cancelled" as const }
            : t,
        ),
      }));
    },

    cancelAll: async () => {
      const running = get().items.filter((t) => t.status === "running");
      await Promise.all(running.map((t) => get().cancel(t.transferId)));
    },

    retry: async (transferId) => {
      const item = get().items.find((t) => t.transferId === transferId);
      if (!item) return;
      if (item.status === "running") return;
      if (!item.localPath || !item.remotePath) {
        throw new Error("缺少路径信息，无法重试");
      }
      if (!item.sessionId) {
        throw new Error("缺少会话信息，无法重试（请重新选择文件传输）");
      }
      get().remove(transferId);
      if (item.direction === "upload") {
        const newId = await sftpUpload(
          item.sessionId,
          item.localPath,
          item.remotePath,
        );
        get().begin({
          transferId: newId,
          direction: "upload",
          label: item.label,
          localPath: item.localPath,
          remotePath: item.remotePath,
          sessionId: item.sessionId,
        });
      } else {
        const newId = await sftpDownload(
          item.sessionId,
          item.remotePath,
          item.localPath,
        );
        get().begin({
          transferId: newId,
          direction: "download",
          label: item.label,
          localPath: item.localPath,
          remotePath: item.remotePath,
          sessionId: item.sessionId,
        });
      }
    },

    clearFinished: () => {
      set((s) => ({
        items: s.items.filter((t) => t.status === "running"),
      }));
    },

    remove: (transferId) => {
      set((s) => ({
        items: s.items.filter((t) => t.transferId !== transferId),
      }));
    },
  }));
}

export const useTransfersStore: ReturnType<typeof createTransfersStore> =
  g[TRANSFERS_KEY] ?? (g[TRANSFERS_KEY] = createTransfersStore());

function normalizeStatus(raw: string): TransferStatus {
  switch (raw) {
    case "done":
    case "failed":
    case "cancelled":
    case "running":
      return raw;
    default:
      return "running";
  }
}

/** Basename helper for labels. */
export function pathBasename(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Whether any transfer is still running (for TransferBar expand default). */
export function hasRunningTransfers(items: TransferItem[]): boolean {
  return items.some((t) => t.status === "running");
}
