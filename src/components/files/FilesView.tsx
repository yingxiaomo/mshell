import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { RemoteEntry } from "../../types/protocol";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { sftpList, sftpRealpath } from "../../lib/tauri";

export function FilesView() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const openEditor = useUiStore((s) => s.openEditor);
  const active = useMemo(
    () => tabs.find((t) => t.sessionId === activeSessionId) ?? null,
    [tabs, activeSessionId],
  );

  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [cwd, setCwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (sessionId: string, dir: string) => {
      setLoading(true);
      setError(null);
      try {
        const dirPath = dir || ".";
        const resolved = await sftpRealpath(sessionId, dirPath);
        setCwd(resolved);
        const list = await sftpList(sessionId, resolved);
        setEntries(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!active || active.disconnected) {
      setEntries([]);
      setCwd("");
      return;
    }
    void refresh(active.sessionId, cwd || ".");
  }, [active?.sessionId, active?.disconnected]);

  function navTo(dir: string) {
    if (!active) return;
    void refresh(active.sessionId, dir);
  }

  function openFile(entry: RemoteEntry) {
    if (!active) return;
    openEditor({
      sessionId: active.sessionId,
      remotePath: entry.path,
      name: entry.name,
    });
  }

  if (!active) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-zinc-500">
            打开会话后可浏览远程文件
          </p>
        </div>
      </div>
    );
  }

  if (active.disconnected) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-amber-500/90 text-sm">会话已断开</p>
        </div>
      </div>
    );
  }

  // Show regular file browser (editor opens in main pane via Shell)
  return (
    <div className="flex h-full flex-col">
      <Header />
      {/* Breadcrumb bar */}
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1">
        <button
          type="button"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => {
            const parts = cwd.split("/");
            parts.pop();
            navTo(parts.join("/") || "/");
          }}
          title="上级目录"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <span className="truncate text-[11px] text-zinc-400">{cwd || "/"}</span>
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => navTo(cwd)}
          title="刷新"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      {error && (
        <p className="border-b border-red-900/40 bg-red-950/30 px-3 py-1 text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex-1 overflow-auto">
        {loading && entries.length === 0 && (
          <p className="p-3 text-xs text-zinc-500">加载中…</p>
        )}
        {!loading && entries.length === 0 && (
          <p className="p-3 text-xs text-zinc-600">空目录</p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800/50"
            onDoubleClick={() => {
              if (entry.isDir) {
                navTo(entry.path);
              } else {
                openFile(entry);
              }
            }}
          >
            <span className="shrink-0 text-zinc-500">
              {entry.isDir ? "📁" : "📄"}
            </span>
            <span className="truncate text-zinc-200">{entry.name}</span>
            {!entry.isDir && (
              <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                {entry.size > 1024 * 1024
                  ? `${(entry.size / 1024 / 1024).toFixed(1)} MB`
                  : entry.size > 1024
                    ? `${(entry.size / 1024).toFixed(1)} KB`
                    : `${entry.size} B`}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="border-b border-zinc-800 px-4 py-3">
      <h1 className="text-sm font-semibold tracking-wide text-zinc-200">文件</h1>
    </div>
  );
}
