import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { RemoteEntry } from "../../types/protocol";
import { useSessionsStore } from "../../stores/sessions";
import {
  pathBasename,
  useTransfersStore,
} from "../../stores/transfers";
import {
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRealpath,
  sftpRename,
  sftpRm,
  sftpUpload,
} from "../../lib/tauri";
import { RemoteEntryRow } from "./RemoteEntryRow";

/** Active session helper for Files sidebar. */
export function useActiveSession() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  return useMemo(
    () => tabs.find((t) => t.sessionId === activeSessionId) ?? null,
    [tabs, activeSessionId],
  );
}

function parentPath(path: string): string | null {
  if (!path || path === "/") return null;
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

function joinRemote(parent: string, name: string): string {
  if (!parent || parent === "/") return `/${name.replace(/^\/+/, "")}`;
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

export function FilesView() {
  const active = useActiveSession();
  const beginTransfer = useTransfersStore((s) => s.begin);
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");

  const load = useCallback(
    async (sessionId: string, path: string) => {
      setLoading(true);
      setError(null);
      try {
        let resolved = path;
        if (!path || path === ".") {
          resolved = await sftpRealpath(sessionId, ".");
        }
        const list = await sftpList(sessionId, resolved);
        setCwd(resolved);
        setPathInput(resolved);
        setEntries(list);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Reload when active session changes.
  useEffect(() => {
    if (!active || active.disconnected) {
      setEntries([]);
      setCwd("");
      setPathInput("");
      setError(null);
      return;
    }
    void load(active.sessionId, ".");
  }, [active?.sessionId, active?.disconnected, load]);

  async function navigate(path: string) {
    if (!active) return;
    await load(active.sessionId, path);
  }

  function onOpenEntry(entry: RemoteEntry) {
    if (entry.isDir) {
      void navigate(entry.path);
    }
  }

  async function goUp() {
    const parent = parentPath(cwd);
    if (parent) void navigate(parent);
  }

  async function onRefresh() {
    if (!active || !cwd) return;
    await load(active.sessionId, cwd);
  }

  async function onMkdir() {
    if (!active || !cwd) return;
    const name = window.prompt("新建文件夹名称");
    if (!name?.trim()) return;
    try {
      await sftpMkdir(active.sessionId, joinRemote(cwd, name.trim()));
      await load(active.sessionId, cwd);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRename(entry: RemoteEntry) {
    if (!active) return;
    const name = window.prompt("重命名为", entry.name);
    if (!name?.trim() || name.trim() === entry.name) return;
    try {
      await sftpRename(
        active.sessionId,
        entry.path,
        joinRemote(cwd, name.trim()),
      );
      await load(active.sessionId, cwd);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDelete(entry: RemoteEntry) {
    if (!active) return;
    if (!window.confirm(`确定删除「${entry.name}」？`)) return;
    try {
      await sftpRm(active.sessionId, entry.path);
      await load(active.sessionId, cwd);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function onUpload() {
    if (!active || !cwd) return;
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        title: "选择要上传的文件",
      });
      if (!selected || Array.isArray(selected)) return;
      const localPath = selected;
      const name = pathBasename(localPath);
      const remotePath = joinRemote(cwd, name);
      const transferId = await sftpUpload(
        active.sessionId,
        localPath,
        remotePath,
      );
      beginTransfer({
        transferId,
        direction: "upload",
        label: name,
        localPath,
        remotePath,
      });
      // Refresh listing after a short delay so small files appear quickly.
      window.setTimeout(() => {
        if (active) void load(active.sessionId, cwd);
      }, 800);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function onDownload(entry: RemoteEntry) {
    if (!active || entry.isDir) return;
    try {
      const dest = await saveDialog({
        defaultPath: entry.name,
        title: "保存到本地",
      });
      if (!dest) return;
      const transferId = await sftpDownload(
        active.sessionId,
        entry.path,
        dest,
      );
      beginTransfer({
        transferId,
        direction: "download",
        label: entry.name,
        localPath: dest,
        remotePath: entry.path,
      });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  if (!active) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-zinc-800 px-4 py-3">
          <h1 className="text-sm font-semibold tracking-wide text-zinc-200">
            文件
          </h1>
        </div>
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-zinc-500">
            打开会话后可在此浏览远程文件
          </p>
        </div>
      </div>
    );
  }

  if (active.disconnected) {
    return (
      <div className="flex h-full flex-col">
        <Header name={active.name} />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-amber-500/90">
            会话已断开，重连后可继续浏览文件
          </p>
        </div>
      </div>
    );
  }

  const crumbs = breadcrumbParts(cwd);

  return (
    <div className="flex h-full flex-col">
      <Header name={active.name} />

      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
        <button
          type="button"
          onClick={() => void goUp()}
          disabled={!parentPath(cwd)}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
          title="上级目录"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
          title="刷新"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={() => void onMkdir()}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          title="新建文件夹"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => void onUpload()}
          className="rounded px-1.5 py-0.5 text-xs text-sky-400/90 hover:bg-zinc-800"
          title="上传文件"
        >
          上传
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void navigate(pathInput.trim() || ".");
          }}
        >
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            className="w-full truncate rounded border border-zinc-800 bg-zinc-950/60 px-2 py-0.5 font-mono text-[11px] text-zinc-300 outline-none focus:border-zinc-600"
            spellCheck={false}
            aria-label="当前路径"
          />
        </form>
      </div>

      {crumbs.length > 0 && (
        <nav
          className="flex flex-wrap items-center gap-0.5 border-b border-zinc-800/80 px-2 py-1 text-[11px]"
          aria-label="路径面包屑"
        >
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 0 && <span className="text-zinc-700">/</span>}
              <button
                type="button"
                onClick={() => void navigate(c.path)}
                className="max-w-[8rem] truncate rounded px-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
      )}

      <div className="flex-1 overflow-auto p-2">
        {loading && entries.length === 0 && (
          <p className="text-sm text-zinc-500">加载中…</p>
        )}
        {error && (
          <p className="mb-2 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && entries.length === 0 && (
          <p className="text-sm text-zinc-500">空目录</p>
        )}
        <ul className="space-y-0.5">
          {entries.map((entry) => (
            <div key={entry.path} className="group relative">
              <RemoteEntryRow entry={entry} onOpen={onOpenEntry} />
              <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover:flex">
                {!entry.isDir && (
                  <button
                    type="button"
                    className="rounded px-1 text-[10px] text-sky-400/80 hover:bg-zinc-800 hover:text-sky-300"
                    onClick={() => void onDownload(entry)}
                  >
                    下载
                  </button>
                )}
                <button
                  type="button"
                  className="rounded px-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                  onClick={() => void onRename(entry)}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="rounded px-1 text-[10px] text-red-400/80 hover:bg-zinc-800"
                  onClick={() => void onDelete(entry)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Header({ name }: { name: string }) {
  return (
    <div className="border-b border-zinc-800 px-4 py-3">
      <h1 className="text-sm font-semibold tracking-wide text-zinc-200">文件</h1>
      <p className="mt-0.5 truncate text-xs text-zinc-500">{name}</p>
    </div>
  );
}

function breadcrumbParts(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const parts = path.split("/").filter(Boolean);
  if (path.startsWith("/")) {
    const out: { label: string; path: string }[] = [{ label: "/", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += `/${p}`;
      out.push({ label: p, path: acc });
    }
    return out;
  }
  // Relative / home without leading slash
  const out: { label: string; path: string }[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push({ label: p, path: acc });
  }
  return out;
}
