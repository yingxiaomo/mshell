import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Columns2, FileText, FolderOpen, Link2, Link2Off, Plus, X } from "lucide-react";
import { cmd, commands } from "../../lib/commands";
import { bus } from "../../lib/events/bus";
import {
  clientErrorMessage,
  parseClientError,
} from "../../types/protocol";
import { useSessionsStore } from "../../stores/sessions";
import { useConnectionsStore } from "../../stores/connections";
import { useSettingsStore } from "../../stores/settings";
import { showToast } from "../ui/Toast";
import { useUiStore } from "../../stores/ui";
import { useSnippetsStore } from "../../stores/snippets";
import { TerminalView } from "./TerminalView";

/** Session tabs — always pinned at the top of the main column. */
export function SessionTabBar() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActive = useSessionsStore((s) => s.setActive);
  const closeTab = useSessionsStore((s) => s.closeTab);
  const opening = useSessionsStore((s) => s.opening);
  const connections = useConnectionsStore((s) => s.items);
  const connColor = useMemo(() => new Map(connections.map((c) => [c.id, c.color])), [connections]);

  if (tabs.length === 0 && !opening) {
    return null;
  }

  return (
    <div className="flex h-11 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-900/80 px-1.5 py-1">
      {tabs.map((tab) => {
        const active = tab.sessionId === activeSessionId;
        return (
          <div
            key={tab.sessionId}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            onClick={() => setActive(tab.sessionId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActive(tab.sessionId);
              }
            }}
            className={
              active
                ? "group flex min-w-[120px] max-w-[240px] cursor-pointer items-center gap-1.5 rounded-md border border-sky-600/40 bg-zinc-800 px-3 text-sm text-zinc-100 shadow-sm"
                : "group flex min-w-[120px] max-w-[240px] cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-3 text-sm text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800/60 hover:text-zinc-200"
            }
            title={tab.name}
          >
            {tab.disconnected ? (
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
                title="已断开"
              />
            ) : tab.connecting ? (
              <span
                className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400"
                title="正在连接…"
              />
            ) : (
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: connColor.get(tab.connectionId) || "rgb(52 211 153 / 0.8)" }}
                title="已连接"
              />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {tab.name}
            </span>
            {tab.synced ? (
              <span
                className="shrink-0 text-sky-400"
                title="此标签已开启同步输入"
              >
                <Link2 className="h-3.5 w-3.5" />
              </span>
            ) : null}
            <button
              type="button"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 opacity-70 hover:bg-zinc-700 hover:text-zinc-100 group-hover:opacity-100"
              title="关闭"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.sessionId).catch((err) => {
                  console.error("[SessionTabBar] closeTab failed", err);
                });
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      {opening && (
        <span className="flex items-center px-3 text-xs text-zinc-500">
          连接中…
        </span>
      )}
    </div>
  );
}

/**
 * Bottom status: sync + modal quick-command dialog.
 * Commands open in a centered modal (same style as add form).
 */
function TerminalStatusBar() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const toggleSync = useSessionsStore((s) => s.toggleSync);
  const items = useSnippetsStore((s) => s.items);
  const loaded = useSnippetsStore((s) => s.loaded);
  const load = useSnippetsStore((s) => s.load);
  const add = useSnippetsStore((s) => s.add);
  const remove = useSnippetsStore((s) => s.remove);
  const run = useSnippetsStore((s) => s.run);

  const [logging, setLogging] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [cmdSearch, setCmdSearch] = useState("");
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const activeTab = tabs.find((t) => t.sessionId === activeSessionId);
  const syncedCount = tabs.filter((t) => t.synced).length;

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  const showMonitor = useUiStore((s) => s.showMonitor);
  const setShowMonitor = useUiStore((s) => s.setShowMonitor);
  const splitSessionId = useUiStore((s) => s.splitSessionId);
  const setSplit = useUiStore((s) => s.setSplit);
  const isSplit = !!splitSessionId && tabs.some((t) => t.sessionId === splitSessionId && t.sessionId !== activeSessionId);
  // Remember the previously-active session so "分屏" splits against what you were
  // just looking at, rather than an arbitrary tab.
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    return () => { prevActiveRef.current = activeSessionId; };
  }, [activeSessionId]);
  const lastOtherId = prevActiveRef.current;

  useEffect(() => {
    if (!addOpen) return;
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [addOpen]);

  useEffect(() => {
    if (!listOpen) { setCmdSearch(""); return; }
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [listOpen]);

  // 搜索过滤 + 按使用频率排序
  const filteredItems = items
    .filter((s) => {
      if (!cmdSearch) return true;
      const q = cmdSearch.toLowerCase();
      return s.name.toLowerCase().includes(q) || s.body.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      // 最近使用的优先
      if (b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed;
      // 使用次数多的优先
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      return a.name.localeCompare(b.name);
    });

  if (!activeTab) return null;

  const synced = !!activeTab.synced;
  const canRun = !activeTab.disconnected;

  const isLogging = !!activeTab && logging.has(activeTab.sessionId);

  async function toggleLog() {
    if (!activeTab) return;
    const sid = activeTab.sessionId;
    if (logging.has(sid)) {
      try { await cmd(commands.sessionLogStop, { sessionId: sid }); } catch { console.warn("[term] log stop failed"); }
      setLogging((s) => { const n = new Set(s); n.delete(sid); return n; });
      showToast("已停止记录会话日志", "info");
      return;
    }
    try {
      // No dialog: auto-save under <Documents>/mshell-logs and report the path.
      const path = await cmd(commands.sessionLogStart, { sessionId: sid });
      setLogging((s) => new Set(s).add(sid));
      showToast(`开始记录会话日志 → ${path}`, "info");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  function openAddForm() {
    setDraftName("");
    setDraftBody("");
    setFormError(null);
    setAddOpen(true);
  }

  function submitAdd() {
    const name = draftName.trim();
    const body = draftBody.trim();
    if (!name || !body) {
      setFormError("备注和命令都不能为空");
      return;
    }
    add(name, body);
    setAddOpen(false);
  }

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-zinc-800 bg-zinc-900 px-1.5 text-[11px]">
        <button
          type="button"
          aria-pressed={synced}
          onClick={() => toggleSync(activeTab.sessionId)}
          className={synced ? "flex h-5 shrink-0 items-center gap-1 rounded bg-sky-600/20 px-1.5 font-medium text-sky-400 hover:bg-sky-600/25" : "flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}
          title={synced ? `同步输入已开启（${syncedCount} 个标签联动）— 点击关闭` : "开启同步输入：键入会同时发送到所有已开启同步的会话"}
        >
          {synced ? <Link2 className="h-3 w-3" strokeWidth={2.25} /> : <Link2Off className="h-3 w-3" strokeWidth={2} />}
          <span>{synced ? `同步 · ${syncedCount}` : "同步"}</span>
        </button>

        <span className="mx-0.5 h-3 w-px shrink-0 bg-zinc-700" aria-hidden />

        <button
          type="button"
          className="flex h-5 items-center gap-1 rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="快捷命令"
          onClick={() => setListOpen(true)}
        >
          <FolderOpen className="h-3 w-3" />
          <span>命令</span>
          {items.length > 0 && (
            <span className="rounded bg-zinc-700 px-1 text-[10px] text-zinc-300">{items.length}</span>
          )}
        </button>

        <button
          type="button"
          className="flex h-5 items-center gap-1 rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
          title="服务器监控"
          onClick={() => setShowMonitor(!showMonitor)}
        >
          <Activity className="h-3 w-3" />
          <span>监控</span>
        </button>

        <button
          type="button"
          aria-pressed={isSplit}
          className={isSplit
            ? "flex h-5 items-center gap-1 rounded bg-sky-600/20 px-1.5 font-medium text-sky-400 hover:bg-sky-600/25"
            : "flex h-5 items-center gap-1 rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}
          title="与另一个会话左右并排（右上角 × 关闭）"
          onClick={() => {
            const others = tabs.filter((t) => t.sessionId !== activeSessionId);
            if (others.length === 0) { showToast("需要至少两个会话才能分屏", "info"); return; }
            // Split the active session against the most-recently-used other one.
            const target =
              (lastOtherId && others.find((t) => t.sessionId === lastOtherId)) || others[0];
            setSplit(target.sessionId);
          }}
        >
          <Columns2 className="h-3 w-3" />
          <span>分屏</span>
        </button>

        <button
          type="button"
          aria-pressed={isLogging}
          className={isLogging
            ? "flex h-5 items-center gap-1 rounded bg-red-600/20 px-1.5 font-medium text-red-400 hover:bg-red-600/25"
            : "flex h-5 items-center gap-1 rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}
          title={isLogging ? "停止记录会话日志" : "记录终端输出到文件"}
          onClick={() => void toggleLog()}
        >
          <FileText className="h-3 w-3" />
          <span>{isLogging ? "记录中" : "记录"}</span>
        </button>

        <span className="mx-0.5 h-3 w-px shrink-0 bg-zinc-700" aria-hidden />

        <div className="flex-1" />

        <span className="hidden max-w-[12rem] shrink-0 truncate text-zinc-600 sm:inline" title={activeTab.name}>
          {activeTab.disconnected ? "已断开" : "已连接"}
          {" · "}
          {activeTab.name}
        </span>
      </div>

      {listOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setListOpen(false); }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
              <h2 className="text-base font-semibold text-zinc-100">快捷命令</h2>
              <button type="button" className="flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500" onClick={openAddForm}>
                <Plus className="h-3.5 w-3.5" />添加
              </button>
            </div>
            <div className="border-b border-zinc-800 px-4 py-2">
              <input
                ref={searchInputRef}
                className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600"
                placeholder="搜索命令…"
                value={cmdSearch}
                onChange={(e) => setCmdSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setListOpen(false); } }}
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-2">
              {filteredItems.length === 0 && (
                <p className="py-6 text-center text-sm text-zinc-500">
                  {cmdSearch ? "未找到匹配命令" : "还没有快捷命令。点「添加」保存备注和命令。"}
                </p>
              )}
              {filteredItems.map((s) => (
                <div key={s.id} className="group flex items-stretch gap-1 rounded-md hover:bg-zinc-800/80">
                  <button type="button" disabled={!canRun} className="min-w-0 flex-1 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40" title={s.body} onClick={() => {
                    setListOpen(false); void run(s.body).catch((e) => { showToast(e instanceof Error ? e.message : String(e), "error"); });
                  }}>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-zinc-100">{s.name}</span>
                      {s.usageCount > 0 && (
                        <span className="shrink-0 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-500">{s.usageCount}</span>
                      )}
                    </div>
                    <div className="truncate font-mono text-xs text-zinc-500">{s.body}</div>
                  </button>
                  <button type="button" className="shrink-0 px-3 text-zinc-600 opacity-0 hover:text-red-400 group-hover:opacity-100" title="删除" onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`删除「${s.name}」？`)) remove(s.id);
                  }}>×</button>
                </div>
              ))}
            </div>
            <div className="flex justify-end border-t border-zinc-800 px-5 py-3">
              <button type="button" className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" onClick={() => setListOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setAddOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="add-cmd-title" className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <h2 id="add-cmd-title" className="mb-1 text-base font-semibold text-zinc-100">添加快捷命令</h2>
            <p className="mb-4 text-xs text-zinc-500">保存后点终端底部「命令」即可发送到当前会话。</p>

            <label className="mb-1 block text-[11px] font-medium text-zinc-400">备注名称</label>
            <input ref={nameInputRef} className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600" placeholder="例如：查看磁盘" value={draftName} onChange={(e) => setDraftName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("add-cmd-body")?.focus(); } if (e.key === "Escape") setAddOpen(false); }} />

            <label className="mb-1 block text-[11px] font-medium text-zinc-400">命令内容</label>
            <textarea id="add-cmd-body" rows={3} className="mb-1 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600" placeholder="例如：df -h" value={draftBody} onChange={(e) => setDraftBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setAddOpen(false); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitAdd(); }}} />
            <p className="mb-3 text-[10px] text-zinc-600">发送时会自动在末尾加回车。Ctrl+Enter 保存。</p>

            {formError && <p className="mb-3 text-xs text-red-400" role="alert">{formError}</p>}

            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" onClick={() => setAddOpen(false)}>取消</button>
              <button type="button" className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500" onClick={submitAdd}>保存</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
/** Terminal body (PTY views + status). Tab bar lives separately at the top of Shell. */
export function TerminalPane() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const connections = useConnectionsStore((s) => s.items);
  const connProtocols = useMemo(() => new Map(connections.map((c) => [c.id, c.protocol])), [connections]);
  const splitSessionId = useUiStore((s) => s.splitSessionId);
  const setSplit = useUiStore((s) => s.setSplit);
  const splitTab =
    splitSessionId && splitSessionId !== activeSessionId
      ? tabs.find((t) => t.sessionId === splitSessionId)
      : undefined;
  const isSplit = !!splitTab;
  // If the user activates the right-pane session (e.g. clicks its tab), swap the
  // two panes instead of collapsing the split.
  const prevActiveRef = useRef(activeSessionId);
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeSessionId;
    if (splitSessionId && activeSessionId === splitSessionId && prev && prev !== activeSessionId) {
      useUiStore.getState().setSplit(prev);
    }
  }, [activeSessionId, splitSessionId]);
  const openError = useSessionsStore((s) => s.openError);
  const opening = useSessionsStore((s) => s.opening);
  const markDisconnected = useSessionsStore((s) => s.markDisconnected);
  const reconnectTab = useSessionsStore((s) => s.reconnectTab);
  const terminalFont = useSettingsStore((s) => s.settings.terminalFont);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
  const autoReconnect = useSettingsStore((s) => s.settings.autoReconnect);

  useEffect(() => {
    const unsub = bus.on("session-disconnected", (ev) => {
      markDisconnected(ev.sessionId, ev.reason);
    });
    return () => unsub();
  }, [markDisconnected]);

  const activeTab = tabs.find((t) => t.sessionId === activeSessionId);

  if (tabs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-zinc-500">
          终端区域 — 双击左侧连接以打开会话
        </p>
        {opening && <p className="text-xs text-sky-400">正在连接…</p>}
        {openError && (
          <p className="max-w-md text-center text-sm text-red-400" role="alert">
            {clientErrorMessage(parseClientError(openError))}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {openError && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-3 py-1 text-xs text-red-300">
          {openError}
        </div>
      )}
      {activeTab?.disconnected && (
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-900/40 bg-amber-950/50 px-3 py-1.5 text-xs text-amber-100"
          role="status"
        >
          <span>
            已断开
            {activeTab.disconnectReason
              ? ` — ${activeTab.disconnectReason}`
              : ""}
            {activeTab.reconnecting
              ? "（重连中…）"
              : autoReconnect
                ? "（自动重连中…）"
                : ""}
          </span>
          <button
            type="button"
            className="rounded bg-amber-600 px-2 py-0.5 font-medium text-white hover:bg-amber-500 disabled:opacity-50"
            disabled={!!activeTab.reconnecting}
            onClick={() => {
              void reconnectTab(activeTab.sessionId).catch(() => {
                /* error stored on tab */
              });
            }}
          >
            重连
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tabs.map((tab) => {
          let slot: "full" | "left" | "right" | "hidden";
          if (isSplit) {
            slot =
              tab.sessionId === activeSessionId ? "left"
              : tab.sessionId === splitTab!.sessionId ? "right"
              : "hidden";
          } else {
            slot = tab.sessionId === activeSessionId ? "full" : "hidden";
          }
          return (
            <TerminalView
              key={tab.sessionId}
              sessionId={tab.sessionId}
              channelId={tab.channelId}
              serialMode={connProtocols.get(tab.connectionId) === "serial"}
              active={tab.sessionId === activeSessionId}
              visible={slot !== "hidden"}
              slot={slot}
              fontFamily={terminalFont}
              fontSize={terminalFontSize}
            />
          );
        })}
        {isSplit && (
          <button
            type="button"
            title={`关闭分屏（${splitTab!.name}）`}
            onClick={() => setSplit(null)}
            className="absolute right-1.5 top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded bg-zinc-800/80 text-zinc-400 shadow hover:bg-zinc-700 hover:text-zinc-100"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <TerminalStatusBar />
    </div>
  );
}

/** @deprecated Prefer SessionTabBar + TerminalPane. */
export function TerminalTabs() {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <SessionTabBar />
      <TerminalPane />
    </div>
  );
}
