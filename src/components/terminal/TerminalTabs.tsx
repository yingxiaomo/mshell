import { useEffect, useRef, useState } from "react";
import { FolderOpen, Link2, Link2Off, Plus, X } from "lucide-react";
import { onSessionDisconnected } from "../../lib/events";
import {
  clientErrorMessage,
  parseClientError,
} from "../../types/protocol";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { showToast } from "../ui/Toast";
import { useSnippetsStore } from "../../stores/snippets";
import { TerminalView } from "./TerminalView";

/** Session tabs — always pinned at the top of the main column. */
export function SessionTabBar() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActive = useSessionsStore((s) => s.setActive);
  const closeTab = useSessionsStore((s) => s.closeTab);
  const opening = useSessionsStore((s) => s.opening);

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
            ) : (
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500/80"
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

  const [listOpen, setListOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const activeTab = tabs.find((t) => t.sessionId === activeSessionId);
  const syncedCount = tabs.filter((t) => t.synced).length;

  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  useEffect(() => {
    if (!addOpen) return;
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [addOpen]);

  if (!activeTab) return null;

  const synced = !!activeTab.synced;
  const canRun = !activeTab.disconnected;

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
            <div className="max-h-64 overflow-y-auto p-2">
              {items.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">还没有快捷命令。点「添加」保存备注和命令。</p>}
              {items.map((s) => (
                <div key={s.id} className="group flex items-stretch gap-1 rounded-md hover:bg-zinc-800/80">
                  <button type="button" disabled={!canRun} className="min-w-0 flex-1 px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40" title={s.body} onClick={() => {
                    setListOpen(false); void run(s.body).catch((e) => { showToast(e instanceof Error ? e.message : String(e), "error"); });
                  }}>
                    <div className="truncate text-sm font-medium text-zinc-100">{s.name}</div>
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
  const openError = useSessionsStore((s) => s.openError);
  const opening = useSessionsStore((s) => s.opening);
  const markDisconnected = useSessionsStore((s) => s.markDisconnected);
  const reconnectTab = useSessionsStore((s) => s.reconnectTab);
  const terminalFont = useSettingsStore((s) => s.settings.terminalFont);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
  const autoReconnect = useSettingsStore((s) => s.settings.autoReconnect);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onSessionDisconnected((ev) => {
      markDisconnected(ev.sessionId, ev.reason);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
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
        {tabs.map((tab) => (
          <TerminalView
            key={tab.sessionId}
            tab={tab}
            active={tab.sessionId === activeSessionId}
            fontFamily={terminalFont}
            fontSize={terminalFontSize}
          />
        ))}
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
