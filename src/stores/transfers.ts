import { create } from "zustand";
import type { TransferProgressEvent, TransferStatus } from "../types/protocol";
import { transferCancel as transferCancelCmd } from "../lib/tauri";

export type TransferDirection = "upload" | "download";

export type TransferItem = {
  transferId: string;
  direction: TransferDirection;
  /** Display label (file name or remote path basename). */
  label: string;
  localPath: string;
  remotePath: string;
  bytes: number;
  total: number | null;
  status: TransferStatus;
  error?: string | null;
  /** Epoch ms when enqueued. */
  startedAt: number;
};

type TransfersState = {
  items: TransferItem[];
  /** Enqueue a local UI row before invoke returns (optimistic id may be replaced). */
  begin: (
    item: Omit<TransferItem, "bytes" | "total" | "status" | "startedAt" | "error"> & {
      transferId: string;
    },
  ) => void;
  applyProgress: (ev: TransferProgressEvent) => void;
  cancel: (transferId: string) => Promise<void>;
  clearFinished: () => void;
  remove: (transferId: string) => void;
};

export const useTransfersStore = create<TransfersState>((set) => ({
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
        // Progress can race ahead of begin(); create a minimal row.
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
      // Job may already have finished.
    }
    set((s) => ({
      items: s.items.map((t) =>
        t.transferId === transferId && t.status === "running"
          ? { ...t, status: "cancelled" as const }
          : t,
      ),
    }));
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
