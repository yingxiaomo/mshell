import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  ArrowLeft,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Upload,
} from "lucide-react";
import type { RemoteEntry } from "../../types/protocol";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { pathBasename, useTransfersStore } from "../../stores/transfers";
import {
  sftpDownload,
  sftpList,
  sftpMkdir,
  sftpRealpath,
  sftpRename,
  sftpChmod,
  sftpRm,
  sftpUpload,
  sftpWriteText,
} from "../../lib/tauri";
import { onTransferProgress } from "../../lib/events";
import {
  ContextMenu,
  type ContextMenuItem,
  type ContextMenuState,
} from "../ui/ContextMenu";
import { showToast } from "../ui/Toast";

function joinRemote(cwd: string, name: string): string {
  if (!cwd || cwd === "/") return `/${name}`.replace(/\/+/g, "/");
  return `${cwd.replace(/\/+$/, "")}/${name}`;
}

function basename(path: string): string {
  return pathBasename(path);
}

export function FilesView() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const openEditor = useUiStore((s) => s.openEditor);
  const beginTransfer = useTransfersStore((s) => s.begin);
  const active = useMemo(
    () => tabs.find((t) => t.sessionId === activeSessionId) ?? null,
    [tabs, activeSessionId],
  );

  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [cwd, setCwd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [menuTarget, setMenuTarget] = useState<RemoteEntry | "blank" | null>(
    null,
  );
  const [dragOver, setDragOver] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const activeRef = useRef(active);
  const cwdRef = useRef(cwd);
  activeRef.current = active;
  cwdRef.current = cwd;

  const refresh = useCallback(async (sessionId: string, dir: string) => {
    setLoading(true);
    setError(null);
    try {
      const dirPath = dir || ".";
      const resolved = await sftpRealpath(sessionId, dirPath);
      setCwd(resolved);
      const list = await sftpList(sessionId, resolved);
      list.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active || active.disconnected) {
      setEntries([]);
      setCwd("");
      return;
    }
    void refresh(active.sessionId, cwd || ".");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sessionId, active?.disconnected]);

  const enqueueUploads = useCallback(
    async (sessionId: string, remoteDir: string, localPaths: string[]) => {
      let ok = 0;
      for (const localPath of localPaths) {
        const name = basename(localPath);
        if (!name || name === "." || name === "..") continue;
        const remotePath = joinRemote(remoteDir, name);
        try {
          const transferId = await sftpUpload(sessionId, localPath, remotePath);
          beginTransfer({
            transferId,
            direction: "upload",
            label: name,
            localPath,
            remotePath,
            sessionId,
          });
          ok += 1;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(`上传失败 ${name}: ${msg}`);
          showToast(`上传失败 ${name}: ${msg}`, "error");
        }
      }
      if (ok > 0) {
        showToast(`已开始上传 ${ok} 个文件`, "info");
      }
    },
    [beginTransfer],
  );

  // When transfers for this session finish, refresh once (debounce multi-file batch).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let refreshTimer: number | undefined;
    let toastTimer: number | undefined;
    let pendingDone = 0;
    let pendingFail = 0;
    let lastFailMsg = "";

    const flush = () => {
      const session = activeRef.current;
      if (!session || session.disconnected) {
        pendingDone = 0;
        pendingFail = 0;
        return;
      }
      void refresh(session.sessionId, cwdRef.current || "/");
      if (pendingDone > 0 && pendingFail === 0) {
        showToast(
          pendingDone === 1
            ? "传输完成，已刷新文件列表"
            : `${pendingDone} 个传输完成，已刷新`,
          "success",
        );
      } else if (pendingFail > 0) {
        showToast(
          pendingFail === 1
            ? lastFailMsg || "传输失败"
            : `${pendingFail} 个传输失败`,
          "error",
        );
      }
      pendingDone = 0;
      pendingFail = 0;
      lastFailMsg = "";
    };

    void onTransferProgress((ev) => {
      if (cancelled) return;
      const st = String(ev.status);
      if (st !== "done" && st !== "failed" && st !== "cancelled") return;
      const session = activeRef.current;
      if (!session || session.disconnected) return;
      if (ev.sessionId && ev.sessionId !== session.sessionId) return;

      if (st === "done") pendingDone += 1;
      else if (st === "failed") {
        pendingFail += 1;
        if (ev.error) lastFailMsg = ev.error;
      }

      window.clearTimeout(refreshTimer);
      window.clearTimeout(toastTimer);
      // Batch multi-file completions into one refresh + toast.
      refreshTimer = window.setTimeout(flush, 400);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearTimeout(toastTimer);
      unlisten?.();
    };
  }, [refresh]);



  // Tauri native file drag-drop (desktop absolute paths).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const session = activeRef.current;
        if (!session || session.disconnected) {
          setDragOver(false);
          return;
        }
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragOver(true);
          return;
        }
        if (payload.type === "leave") {
          setDragOver(false);
          return;
        }
        if (payload.type === "drop") {
          setDragOver(false);
          const paths = payload.paths ?? [];
          if (paths.length === 0) return;
          void enqueueUploads(session.sessionId, cwdRef.current || "/", paths);
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        /* browser preview */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [enqueueUploads]);

  function navTo(dir: string) {
    if (!active) return;
    setSelection(new Set());
    void refresh(active.sessionId, dir);
  }

  function toggleSelection(path: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectAll() {
    if (selection.size === entries.length) {
      setSelection(new Set());
    } else {
      setSelection(new Set(entries.map((e) => e.path)));
    }
  }

  async function deleteSelected() {
    const names = entries.filter((e) => selection.has(e.path)).map((e) => e.name);
    if (names.length === 0) return;
    if (!window.confirm(`确定删除 ${names.length} 个文件？
${names.slice(0, 5).join(', ')}${names.length > 5 ? `…等${names.length}项` : ''}`)) return;
    if (!active) return;
    for (const path of selection) {
      try { await sftpRm(active.sessionId, path); }
      catch (e) { showToast(`删除失败: ${e instanceof Error ? e.message : e}`, 'error'); }
    }
    setSelection(new Set());
    void refresh(active.sessionId, cwd);
  }

  function openFile(entry: RemoteEntry) {
    if (!active) return;
    openEditor({
      sessionId: active.sessionId,
      remotePath: entry.path,
      name: entry.name,
    });
  }

  async function runAction(id: string) {
    if (!active) return;
    const sessionId = active.sessionId;
    const target = menuTarget;

    try {
      switch (id) {
        case "open": {
          if (!target || target === "blank") return;
          if (target.isDir) navTo(target.path);
          else openFile(target);
          break;
        }
        case "copy-path": {
          if (!target || target === "blank") return;
          await navigator.clipboard.writeText(target.path);
          break;
        }
        case "rename": {
          if (!target || target === "blank") return;
          const next = window.prompt("新名称：", target.name);
          if (!next || next === target.name) return;
          if (next.includes("/") || next.includes("\\")) {
            showToast("名称不能包含路径分隔符", "error");
            return;
          }
          const parent = target.path.replace(/\/[^/]+\/?$/, "") || "/";
          const to = joinRemote(parent === target.path ? cwd : parent, next);
          await sftpRename(sessionId, target.path, to);
          await refresh(sessionId, cwd);
          break;
        }
        case "chmod": {
          if (!target || target === "blank") return;
          const modeStr = window.prompt("输入权限数字（如 644、755）：", "644");
          if (!modeStr) return;
          const mode = parseInt(modeStr, 8);
          if (isNaN(mode) || mode < 0 || mode > 0o777) {
            window.alert("无效的权限值。请输入八进制数字，如 644、755。");
            return;
          }
          await sftpChmod(sessionId, target.path, mode);
          showToast("权限已修改", "success");
          break;
        }
        case "delete": {
          if (!target || target === "blank") return;
          const ok = window.confirm(
            target.isDir
              ? `确定删除目录「${target.name}」？\n（需为空目录，或后端支持递归）`
              : `确定删除「${target.name}」？`,
          );
          if (!ok) return;
          await sftpRm(sessionId, target.path);
          await refresh(sessionId, cwd);
          break;
        }
        case "mkdir": {
          const name = window.prompt("新建文件夹名称：");
          if (!name?.trim()) return;
          const path = joinRemote(cwd, name.trim());
          await sftpMkdir(sessionId, path);
          await refresh(sessionId, cwd);
          break;
        }
        case "new-file": {
          const name = window.prompt("新建文件名称：");
          if (!name?.trim()) return;
          const path = joinRemote(cwd, name.trim());
          await sftpWriteText(sessionId, path, btoa(""));
          await refresh(sessionId, cwd);
          openEditor({
            sessionId,
            remotePath: path,
            name: name.trim(),
          });
          break;
        }
        case "upload": {
          const selected = await open({
            multiple: true,
            directory: false,
            title: "选择要上传的文件",
          });
          if (!selected) return;
          const files = Array.isArray(selected) ? selected : [selected];
          await enqueueUploads(sessionId, cwd, files);
          break;
        }
        case "download": {
          if (!target || target === "blank" || target.isDir) return;
          const localPath = await save({
            title: "下载到…",
            defaultPath: target.name,
          });
          if (!localPath) return;
          const transferId = await sftpDownload(
            sessionId,
            target.path,
            localPath,
          );
          beginTransfer({
            transferId,
            direction: "download",
            label: target.name,
            localPath,
            remotePath: target.path,
            sessionId,
          });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      showToast(msg, "error");
    }
  }

  function openEntryMenu(e: React.MouseEvent, entry: RemoteEntry) {
    e.preventDefault();
    e.stopPropagation();
    setMenuTarget(entry);
    const items: ContextMenuItem[] = entry.isDir
      ? [
          { kind: "item", id: "open", label: "打开" },
          { kind: "item", id: "copy-path", label: "复制路径" },
          { kind: "sep", id: "s1" },
          { kind: "item", id: "rename", label: "重命名" },
          { kind: "item", id: "chmod", label: "权限…" },
          { kind: "item", id: "delete", label: "删除", danger: true },
        ]
      : [
          { kind: "item", id: "open", label: "打开" },
          { kind: "item", id: "download", label: "下载…" },
          { kind: "item", id: "copy-path", label: "复制路径" },
          { kind: "sep", id: "s1" },
          { kind: "item", id: "rename", label: "重命名" },
          { kind: "item", id: "chmod", label: "权限…" },
          { kind: "item", id: "delete", label: "删除", danger: true },
        ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function openBlankMenu(e: React.MouseEvent) {
    e.preventDefault();
    setMenuTarget("blank");
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { kind: "item", id: "upload", label: "上传文件…" },
        { kind: "item", id: "new-file", label: "新建文件…" },
        { kind: "item", id: "mkdir", label: "新建文件夹…" },
        { kind: "sep", id: "s1" },
        {
          kind: "item",
          id: "copy-path",
          label: "复制当前路径",
          disabled: !cwd,
        },
      ],
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

  return (
    <div className="flex h-full flex-col">
      <Header />
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
        <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-400">
          {cwd || "/"}
        </span>
        <button
          type="button"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="上传"
          onClick={() => void runAction("upload")}
        >
          <Upload className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="新建文件"
          onClick={() => void runAction("new-file")}
        >
          <FilePlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="新建文件夹"
          onClick={() => void runAction("mkdir")}
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        {selection.size > 0 && (
          <div className="flex items-center gap-1.5 mr-1">
            <span className="text-[10px] text-sky-400">{selection.size}</span>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-950/30"
              onClick={() => void deleteSelected()}
            >
              删除
            </button>
          </div>
        )}
        <button
          type="button"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => selectAll()}
          title={selection.size === entries.length ? "取消全选" : "全选"}
        >
          <span className="text-[13px]">{selection.size === entries.length ? "☑" : "☐"}</span>
        </button>
        <button
          type="button"
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
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
      <div
        className={
          dragOver
            ? "relative flex-1 overflow-auto bg-sky-600/10 ring-2 ring-inset ring-sky-500"
            : "relative flex-1 overflow-auto"
        }
        onContextMenu={openBlankMenu}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="rounded-lg border border-dashed border-sky-500 bg-zinc-900/90 px-4 py-3 text-sm text-sky-300 shadow-lg">
              松开以上传到 {cwd || "/"}
            </div>
          </div>
        )}
        {loading && entries.length === 0 && (
          <p className="p-3 text-xs text-zinc-500">加载中…</p>
        )}
        {!loading && entries.length === 0 && (
          <p className="p-3 text-xs text-zinc-600">
            空目录 — 右键或拖入文件可上传
          </p>
        )}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800/50"
            style={{ backgroundColor: selection.has(entry.path) ? 'rgba(14,165,233,0.1)' : undefined }}
            onDoubleClick={() => {
              if (entry.isDir) navTo(entry.path);
              else openFile(entry);
            }}
            onContextMenu={(e) => openEntryMenu(e, entry)}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 shrink-0 accent-sky-500"
              checked={selection.has(entry.path)}
              onChange={() => toggleSelection(entry.path)}
              onClick={(e) => e.stopPropagation()}
            />
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

      <ContextMenu
        menu={menu}
        onClose={() => {
          setMenu(null);
          setMenuTarget(null);
        }}
        onSelect={(id) => {
          if (id === "copy-path" && menuTarget === "blank" && cwd) {
            void navigator.clipboard.writeText(cwd);
            return;
          }
          void runAction(id);
        }}
      />
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
