import { useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import type { TransferItem } from "../../stores/transfers";
import {
  hasRunningTransfers,
  useTransfersStore,
} from "../../stores/transfers";
import { onTransferProgress } from "../../lib/events";
import { showToast } from "../ui/Toast";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function progressPct(item: TransferItem): number {
  if (!item.total || item.total <= 0) {
    return item.status === "done" ? 100 : 0;
  }
  return Math.min(100, Math.round((item.bytes / item.total) * 100));
}

function statusLabel(status: TransferItem["status"]): string {
  switch (status) {
    case "running":
      return "传输中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

export function TransferBar() {
  const items = useTransfersStore((s) => s.items);
  const cancel = useTransfersStore((s) => s.cancel);
  const cancelAll = useTransfersStore((s) => s.cancelAll);
  const retry = useTransfersStore((s) => s.retry);
  const clearFinished = useTransfersStore((s) => s.clearFinished);
  const remove = useTransfersStore((s) => s.remove);
  const applyProgress = useTransfersStore((s) => s.applyProgress);

  const running = useMemo(() => hasRunningTransfers(items), [items]);
  const finishedCount = useMemo(
    () => items.filter((t) => t.status !== "running").length,
    [items],
  );
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onTransferProgress((ev) => {
      applyProgress(ev);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [applyProgress]);

  useEffect(() => {
    if (running) setExpanded(true);
  }, [running]);

  if (items.length === 0) return null;

  const runningCount = items.filter((t) => t.status === "running").length;
  const summary = running
    ? `${runningCount} 个传输中`
    : `${items.length} 个传输`;

  return (
    <div className="border-t border-zinc-800 bg-zinc-900 text-xs text-zinc-300">
      <div className="flex h-7 items-center gap-2 px-3">
        <button
          type="button"
          className="text-zinc-400 hover:text-zinc-200"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "▾" : "▸"} 传输
        </button>
        <span className="text-zinc-500">{summary}</span>
        <div className="flex-1" />
        {running && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
            onClick={() => void cancelAll()}
            title="取消全部进行中的传输"
          >
            全部取消
          </button>
        )}
        {finishedCount > 0 && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            onClick={() => clearFinished()}
            title="清除已完成 / 失败 / 已取消"
          >
            清除完成
          </button>
        )}
      </div>

      {expanded && (
        <ul className="max-h-44 overflow-auto border-t border-zinc-800 px-2 py-1">
          {items.map((item) => {
            const pct = progressPct(item);
            const canRetry =
              (item.status === "failed" || item.status === "cancelled") &&
              !!item.localPath &&
              !!item.remotePath &&
              !!item.sessionId;
            return (
              <li
                key={item.transferId}
                className="mb-1 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      "shrink-0 rounded px-1 text-[10px] uppercase",
                      item.direction === "upload"
                        ? "bg-sky-950 text-sky-400"
                        : "bg-emerald-950 text-emerald-400",
                    )}
                  >
                    {item.direction === "upload" ? "上传" : "下载"}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={item.label}>
                    {item.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-500">
                    {formatBytes(item.bytes)}
                    {item.total != null ? ` / ${formatBytes(item.total)}` : ""}
                  </span>
                  <span
                    className={clsx(
                      "w-10 shrink-0 text-right",
                      item.status === "failed" && "text-red-400",
                      item.status === "done" && "text-emerald-500",
                      item.status === "cancelled" && "text-zinc-500",
                      item.status === "running" && "text-sky-400",
                    )}
                  >
                    {item.status === "running"
                      ? `${pct}%`
                      : statusLabel(item.status)}
                  </span>
                  {item.status === "running" && (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                      onClick={() => void cancel(item.transferId)}
                    >
                      取消
                    </button>
                  )}
                  {canRetry && (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-sky-400"
                      onClick={() => {
                        void retry(item.transferId).catch((e) => {
                          showToast(e instanceof Error ? e.message : String(e), "error");
                        });
                      }}
                    >
                      重试
                    </button>
                  )}
                  {item.status !== "running" && (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                      title="移除"
                      onClick={() => remove(item.transferId)}
                    >
                      ×
                    </button>
                  )}
                </div>
                {item.status === "running" && (
                  <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800">
                    <div
                      className="h-full bg-sky-600 transition-[width] duration-150"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                {item.error && (
                  <p className="mt-0.5 truncate text-[10px] text-red-400">
                    {item.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
