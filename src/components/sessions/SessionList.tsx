import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { Connection, HostKeyPrompt } from "../../types/protocol";
import {
  clientErrorMessage,
  parseClientError,
} from "../../types/protocol";
import { useConnectionsStore } from "../../stores/connections";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { showToast } from "../ui/Toast";
import { cmd, commands } from "../../lib/commands";
import { estimateTerminalGeometry } from "../../lib/terminalGeometry";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { open } from "@tauri-apps/plugin-dialog";
import { HostKeyDialog } from "../connection/HostKeyDialog";
import { QuickConnectDialog, type QuickConnectParams } from "../connection/QuickConnectDialog";
import { SessionListItem } from "./SessionListItem";


function polishOpenError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('password not found')) {
    return '未找到已保存的密码。请编辑连接并重新填写密码后保存，再双击连接。';
  }
  return msg;
}

function matchesQuery(c: Connection, q: string): boolean {
  if (!q) return true;
  const hay = [
    c.name,
    c.host,
    c.username,
    c.group ?? "",
    c.notes ?? "",
    ...c.tags,
    `${c.port}`,
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

export function SessionList() {
  const items = useConnectionsStore((s) => s.items);
  const imported = useConnectionsStore((s) => s.imported);
  const loading = useConnectionsStore((s) => s.loading);
  const error = useConnectionsStore((s) => s.error);
  const load = useConnectionsStore((s) => s.load);
  const reloadQuiet = useConnectionsStore((s) => s.reloadQuiet);
  const remove = useConnectionsStore((s) => s.remove);
  const allFn = useConnectionsStore((s) => s.all);
  const recentsFn = useConnectionsStore((s) => s.recents);
  const duplicateAsLocal = useConnectionsStore((s) => s.duplicateAsLocal);
  const importPutty = useConnectionsStore((s) => s.importPutty);
  const saveConn = useConnectionsStore((s) => s.save);

  const merged = useMemo(
    () => allFn(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, imported, allFn],
  );

  const recents = useMemo(
    () => recentsFn(5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, recentsFn],
  );

  const setOpening = useSessionsStore((s) => s.setOpening);
  const setOpenError = useSessionsStore((s) => s.setOpenError);
  const switchToFilesOnOpen = useSettingsStore(
    (s) => s.settings.switchToFilesOnOpen,
  );
  const setActiveView = useUiStore((s) => s.setActiveView);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpHost, setMcpHost] = useState({ name: "", host: "", port: "22", username: "root", password: "" });
  const [editing, setEditing] = useState<Connection | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(
    null,
  );
  const [dismissedTip, setDismissedTip] = useState(
    () => localStorage.getItem('mshell.dismissedFirstTip') === 'true'
  );
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? merged.filter((c) => matchesQuery(c, q)) : merged),
    [merged, q],
  );

  // Group connections: ungrouped + per-group (respect search filter).
  const grouped = useMemo(() => {
    const groups = new Map<string, Connection[]>();
    const ungrouped: Connection[] = [];
    for (const c of filtered) {
      const g = c.group || "";
      if (!g) {
        ungrouped.push(c);
      } else {
        let list = groups.get(g);
        if (!list) {
          list = [];
          groups.set(g, list);
        }
        list.push(c);
      }
    }
    const sortedGroups = [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    return { ungrouped, groups: sortedGroups };
  }, [filtered]);

  // Recent section: only when not searching; hide items already shown? Show always as shortcut.
  const showRecents = !q && recents.length > 0;

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(c: Connection) {
    if (c.source?.type === "sshConfig") return;
    setEditing(c);
    setDialogOpen(true);
  }

  async function handleDelete(id: string) {
    if (!window.confirm("确定删除该连接？凭据也会一并清除。")) return;
    try {
      await remove(id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function handleDuplicate(c: Connection) {
    try {
      await duplicateAsLocal(c);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function onImportMcp() {
    // Try common locations first, then let user pick
    try {
      let servers = await cmd(commands.importMcpServers);
      if (servers.length > 0) {
        for (const s of servers) await saveConn(s);
        showToast(`已从 MCP 配置导入 ${servers.length} 台服务器`, "success");
        void reloadQuiet();
        return;
      }
    } catch { /* fall through to file picker */ }

    // No auto-detected config → let user pick the file
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "MCP Config", extensions: ["json"] }],
      });
      if (!selected) return;
      const content = await cmd(commands.readSshConfigText, { path: selected });
      if (!content) { showToast("文件为空", "info"); return; }
      // Parse as JSON array of hosts or as mcpServers format
      let servers: Connection[] = [];
      try {
        const raw = JSON.parse(content);
        const hosts = Array.isArray(raw) ? raw : raw.hosts || raw.servers || [];
        for (const h of hosts) {
          servers.push({
            id: crypto.randomUUID(),
            name: h.name || h.host || "unknown",
            host: h.host || h.HostName || "localhost",
            port: h.port || h.Port || 22,
            protocol: "ssh",
            username: h.username || h.User || "root",
            auth: { type: "password", credentialId: "" },
            group: "MCP",
            tags: ["mcp"],
            jumpHost: null,
            tunnels: [],
            source: { type: "manual" },
            lastConnected: null,
            notes: null,
            serialConfig: null,
            onConnect: null,
            color: null,
          } satisfies Connection);
        }
      } catch {
        // Treat as SSH config file format
        const lines = content.split("\n");
        let current: any = {};
        for (const line of lines) {
          const m = line.match(/^Host\s+(.+)/);
          if (m) {
            if (current.name) {
              servers.push(buildConnFromConfig(current));
            }
            current = { name: m[1].trim() };
          } else {
            const kv = line.match(/^\s+(\w+)\s+(.+)/);
            if (kv) current[kv[1]!.toLowerCase()] = kv[2]!.trim();
          }
        }
        if (current.name) servers.push(buildConnFromConfig(current));
      }
      if (servers.length === 0) { showToast("未找到服务器配置", "info"); return; }
      for (const s of servers) await saveConn(s);
      showToast(`已导入 ${servers.length} 台服务器`, "success");
      void reloadQuiet();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  function buildConnFromConfig(cfg: any): Connection {
    return {
      id: crypto.randomUUID(),
      name: cfg.name,
      host: cfg.hostname || cfg.host || "localhost",
      port: Number(cfg.port) || 22,
      protocol: "ssh",
      username: cfg.user || cfg.username || "root",
      auth: { type: "password", credentialId: "" },
      group: "MCP",
      tags: ["mcp"],
      jumpHost: null,
      tunnels: [],
      source: { type: "manual" },
      lastConnected: null,
      notes: null,
      serialConfig: null,
      onConnect: null,
      color: null,
    };
  }

  async function handleOpen(connection: Connection) {
    if (connection.source?.type === "sshConfig") {
      showToast("导入的 ssh config 主机为只读，请先「复制为本地」再连接。", "error");
      return;
    }
    setOpening(true);
    setOpenError(null);

    if (!useUiStore.getState().showMonitor) {
      useUiStore.getState().setShowMonitor(true);
    }
    // Show the tab immediately as "connecting" so the user sees feedback
    // even when SSH handshakes are serialized by the backend.
    const pendingId = crypto.randomUUID();
    useSessionsStore.setState((s) => ({
      tabs: [
        ...s.tabs,
        {
          sessionId: pendingId,
          connectionId: connection.id,
          channelId: pendingId,
          name: connection.name,
          connecting: true,
          disconnected: false,
          reconnecting: false,
        },
      ],
      activeSessionId: pendingId,
      openError: null,
    }));
    // Flush React's batched state updates so the placeholder tab renders
    // before we await the potentially-blocked SSH handshake.
    await new Promise<void>((r) => setTimeout(r, 0));
    try {
      const { cols, rows } = estimateTerminalGeometry();
      const result = await cmd(commands.sessionOpen, { connectionId: connection.id, cols, rows });
      // Only attach if user hasn't closed the placeholder tab while waiting.
      const tabStillExists = useSessionsStore.getState().tabs.some((t) => t.sessionId === pendingId);
      if (tabStillExists) {
        useSessionsStore.getState().markConnected(pendingId, result.sessionId, result.terminalChannelId, result);
      } else {
        // Tab was closed — close the orphaned backend session too.
        cmd(commands.sessionClose, { sessionId: result.sessionId }).catch((e) => console.warn(e));
      }
      void reloadQuiet();
      if (switchToFilesOnOpen) {
        setActiveView("files");
      }
    } catch (e) {
      useSessionsStore.getState().removeTabLocal(pendingId);
      const cerr = parseClientError(e);
      if (
        cerr.kind === "hostKeyChanged" ||
        cerr.kind === "hostKeyUnknown"
      ) {
        setHostKeyPrompt({
          kind: cerr.kind,
          fingerprint: cerr.fingerprint,
          host: cerr.host,
          connectionId: connection.id,
          connectionName: connection.name,
        });
        setOpenError(null);
      } else {
        let msg = clientErrorMessage(cerr);
        if (cerr.kind === "auth" && /password not found/i.test(msg)) {
          msg =
            "未找到已保存的密码。请编辑该连接并重新填写密码后保存，再双击连接。";
        }
        setOpenError(polishOpenError(msg));
      }
    } finally {
      setOpening(false);
    }
  }

  async function handleQuickConnect(params: QuickConnectParams) {
    setOpening(true);
    setOpenError(null);
    if (!useUiStore.getState().showMonitor) {
      useUiStore.getState().setShowMonitor(true);
    }
    const pendingId = crypto.randomUUID();
    const name = `${params.username}@${params.host}`;
    useSessionsStore.setState((s) => ({
      tabs: [
        ...s.tabs,
        { sessionId: pendingId, connectionId: pendingId, channelId: pendingId, name, connecting: true, disconnected: false, reconnecting: false },
      ],
      activeSessionId: pendingId,
      openError: null,
    }));
    await new Promise<void>((r) => setTimeout(r, 0));
    try {
      const { cols, rows } = estimateTerminalGeometry();
      const result = await cmd(commands.sessionOpenAdhoc, {
        host: params.host,
        port: params.port,
        username: params.username,
        authType: params.authType,
        password: params.password ?? null,
        keyPath: params.keyPath ?? null,
        cols,
        rows,
      });
      const tabStillExists = useSessionsStore.getState().tabs.some((t) => t.sessionId === pendingId);
      if (tabStillExists) {
        useSessionsStore.getState().markConnected(pendingId, result.sessionId, result.terminalChannelId, result);
      } else {
        cmd(commands.sessionClose, { sessionId: result.sessionId }).catch((e) => console.warn(e));
      }
      if (switchToFilesOnOpen) setActiveView("files");
    } catch (e) {
      useSessionsStore.getState().removeTabLocal(pendingId);
      const msg = clientErrorMessage(parseClientError(e));
      setOpenError(polishOpenError(msg));
      throw new Error(msg); // surface in the dialog too
    } finally {
      setOpening(false);
    }
  }

  function renderItem(c: Connection) {
    return (
      <SessionListItem
        key={
          c.source?.type === "sshConfig"
            ? `sshcfg:${c.source.path}:${c.source.hostAlias}`
            : c.id
        }
        connection={c}
        onEdit={openEdit}
        onDelete={handleDelete}
        onOpen={handleOpen}
        onDuplicateAsLocal={handleDuplicate}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2.5">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">
          连接
        </h1>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setQuickOpen(true)}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            title="快速连接（不保存）"
          >
            快连
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500"
          >
            新建
          </button>
          <button
            type="button"
            onClick={() => void importPutty()}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            title="从 PuTTY 导入会话"
          >
            PuTTY
          </button>
          <button
            type="button"
            onClick={() => setMcpOpen(true)}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            title="MCP 服务器管理"
          >
            MCP
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="border-b border-zinc-800 px-3 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称 / 主机 / 用户 / 分组…"
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          {query && (
            <button
              type="button"
              className="rounded p-0.5 text-zinc-500 hover:text-zinc-300"
              title="清除"
              onClick={() => setQuery("")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {loading && merged.length === 0 && (
          <p className="text-sm text-zinc-500">加载中…</p>
        )}
        {error && (
          <p className="mb-2 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        {!loading && merged.length === 0 && !dismissedTip && (
          <div className="mx-3 mb-2 mt-2 rounded-md border border-sky-600/30 bg-sky-950/20 px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[11px] font-medium text-sky-300">首次使用？</p>
              <button
                type="button"
                className="shrink-0 rounded px-1 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={() => {
                  localStorage.setItem('mshell.dismissedFirstTip', 'true');
                  setDismissedTip(true);
                }}
              >
                ✕
              </button>
            </div>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              点「新建」创建 SSH/Telnet/本地终端，或从 ~/.ssh/config、PuTTY 导入。
              按 <kbd className="rounded border border-zinc-700 px-0.5">?</kbd> 查看快捷键。
            </p>
          </div>
        )}
        {!loading && merged.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <p className="text-sm text-zinc-400">还没有连接</p>
            <p className="max-w-xs text-xs text-zinc-600">
              新建 SSH / Telnet / 本地终端，或导入 ~/.ssh/config、PuTTY 会话。
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={openCreate}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
              >
                新建连接
              </button>
              <button
                type="button"
                onClick={() => void importPutty()}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                导入 PuTTY
              </button>
            </div>
            <p className="text-[11px] text-zinc-600">
              提示：按{" "}
              <kbd className="rounded border border-zinc-700 px-1">Ctrl+P</kbd>{" "}
              打开命令面板，
              <kbd className="rounded border border-zinc-700 px-1">?</kbd>{" "}
              查看快捷键
            </p>
          </div>
        )}
        {q && filtered.length === 0 && merged.length > 0 && (
          <p className="text-sm text-zinc-500">无匹配「{query.trim()}」的连接</p>
        )}

        <ul className="space-y-2">
          {showRecents && (
            <li className="mb-1">
              <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                最近
              </div>
              <ul className="space-y-1.5">
                {recents.map((c) => renderItem(c))}
              </ul>
            </li>
          )}

          {showRecents && filtered.length > 0 && (
            <li className="pt-1">
              <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                全部
              </div>
            </li>
          )}

          {grouped.ungrouped.map((c) => renderItem(c))}

          {grouped.groups.map(([groupName, groupItems]) => {
            const collapsed = collapsedGroups[groupName] ?? false;
            return (
              <li key={groupName}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                  onClick={() =>
                    setCollapsedGroups((prev) => ({
                      ...prev,
                      [groupName]: !(prev[groupName] ?? false),
                    }))
                  }
                >
                  <span className="text-[10px]">
                    {collapsed ? "▶" : "▼"}
                  </span>
                  {groupName}
                  <span className="ml-auto text-[10px] text-zinc-600">
                    {groupItems.length}
                  </span>
                </button>
                {!collapsed && (
                  <ul className="mt-1 space-y-1.5 pl-2">
                    {groupItems.map((c) => renderItem(c))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <ConnectionDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
      <HostKeyDialog
        prompt={hostKeyPrompt}
        onClose={() => setHostKeyPrompt(null)}
      />
      <QuickConnectDialog
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onConnect={handleQuickConnect}
      />

      {/* MCP 导入/添加弹窗 */}
      {mcpOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setMcpOpen(false); }}>
          <div role="dialog" className="flex flex-col gap-3 w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-zinc-100">MCP 服务器</h2>
            <p className="text-xs text-zinc-500">从配置文件导入或手动添加。</p>

            {/* 手动添加 */}
            <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/50 p-3">
              <p className="text-xs font-medium text-zinc-400">手动添加</p>
              <input placeholder="名称（例如 HK-5块）" value={mcpHost.name} onChange={(e) => setMcpHost({ ...mcpHost, name: e.target.value })}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-600 placeholder:text-zinc-600" />
              <input placeholder="主机地址" value={mcpHost.host} onChange={(e) => setMcpHost({ ...mcpHost, host: e.target.value })}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-600 placeholder:text-zinc-600" />
              <div className="flex gap-2">
                <input placeholder="端口" value={mcpHost.port} onChange={(e) => setMcpHost({ ...mcpHost, port: e.target.value })}
                  className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-600 placeholder:text-zinc-600" />
                <input placeholder="用户名" value={mcpHost.username} onChange={(e) => setMcpHost({ ...mcpHost, username: e.target.value })}
                  className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-600 placeholder:text-zinc-600" />
              </div>
              <input type="password" placeholder="密码（可选）" value={mcpHost.password} onChange={(e) => setMcpHost({ ...mcpHost, password: e.target.value })}
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-600 placeholder:text-zinc-600" />
              <button type="button"
                disabled={!mcpHost.name || !mcpHost.host}
                onClick={async () => {
                  try {
                    await saveConn({
                      id: crypto.randomUUID(), name: mcpHost.name, host: mcpHost.host,
                      port: Number(mcpHost.port) || 22, protocol: "ssh",
                      username: mcpHost.username || "root",
                      auth: mcpHost.password
                        ? { type: "password", credentialId: "" }
                        : { type: "agent" },
                      group: "MCP", tags: ["mcp"], jumpHost: null, tunnels: [],
                      source: { type: "manual" }, lastConnected: null,
                      notes: null, serialConfig: null, onConnect: null, color: null,
                    } satisfies Connection);
                    showToast(`已添加 ${mcpHost.name}`, "success");
                    setMcpHost({ name: "", host: "", port: "22", username: "root", password: "" });
                    void reloadQuiet();
                  } catch (e) { showToast(e instanceof Error ? e.message : String(e), "error"); }
                }}
                className="w-full rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50">
                添加
              </button>
            </div>

            {/* 从文件导入 */}
            <button type="button" onClick={() => { void onImportMcp(); setMcpOpen(false); }}
              className="w-full rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
              从文件导入
            </button>

            <button type="button" onClick={() => setMcpOpen(false)}
              className="w-full rounded-md px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300">
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
