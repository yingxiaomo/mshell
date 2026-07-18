import { useEffect } from "react";
import { X } from "lucide-react";
import { onSessionDisconnected } from "../../lib/events";
import {
  clientErrorMessage,
  parseClientError,
} from "../../types/protocol";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { TerminalView } from "./TerminalView";

export function TerminalTabs() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActive = useSessionsStore((s) => s.setActive);
  const closeTab = useSessionsStore((s) => s.closeTab);
  const openError = useSessionsStore((s) => s.openError);
  const opening = useSessionsStore((s) => s.opening);
  const markDisconnected = useSessionsStore((s) => s.markDisconnected);
  const reconnectTab = useSessionsStore((s) => s.reconnectTab);
  const toggleSync = useSessionsStore((s) => s.toggleSync);
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
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-zinc-600">
          终端区域 — 双击连接以打开会话
        </p>
        {opening && (
          <p className="text-xs text-zinc-500">正在连接…</p>
        )}
        {openError && (
          <p className="max-w-md text-center text-sm text-red-400" role="alert">
            {clientErrorMessage(parseClientError(openError))}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-800 bg-zinc-900/80 px-1">
        {tabs.map((tab) => {
          const active = tab.sessionId === activeSessionId;
          return (
            <div
              key={tab.sessionId}
              className={
                active
                  ? "group flex max-w-[200px] items-center gap-1 border-b-2 border-sky-500 bg-zinc-800/80 px-2 py-1.5 text-xs text-zinc-100"
                  : "group flex max-w-[200px] items-center gap-1 border-b-2 border-transparent px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
              }
            >
              <button
                type="button"
                className="truncate"
                onClick={() => setActive(tab.sessionId)}
                title={tab.name}
              >
                {tab.disconnected ? (
                  <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" />
                ) : null}
                {tab.name}
              </button>
              <button
                type="button"
                className={
                  tab.synced
                    ? "rounded px-0.5 text-[10px] text-sky-400 hover:text-sky-300"
                    : "rounded px-0.5 text-[10px] text-zinc-600 hover:text-zinc-400"
                }
                title={
                  tab.synced
                    ? "同步输入已开启"
                    : "点击开启同步输入（键盘输入同时发到所有同步标签）"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSync(tab.sessionId);
                }}
              >
                ●
              </button>
              <button
                type="button"
                className="rounded p-0.5 text-zinc-500 opacity-70 hover:bg-zinc-700 hover:text-zinc-200 group-hover:opacity-100"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.sessionId);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {opening && (
          <span className="px-2 text-[11px] text-zinc-500">连接中…</span>
        )}
      </div>
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
      <div className="relative min-h-0 flex-1 bg-zinc-950 p-1">
        {tabs.map((tab) => (
          <TerminalView
            key={`${tab.sessionId}:${terminalFont}:${terminalFontSize}`}
            tab={tab}
            active={tab.sessionId === activeSessionId}
            fontFamily={terminalFont}
            fontSize={terminalFontSize}
          />
        ))}
      </div>
    </div>
  );
}
