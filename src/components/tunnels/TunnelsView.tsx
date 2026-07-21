import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Network, Play, Square } from "lucide-react";
import type { TunnelConfig, TunnelStatus, TunnelType } from "../../types/protocol";
import { useSessionsStore } from "../../stores/sessions";
import { useConnectionsStore } from "../../stores/connections";
import { onTunnelStatus } from "../../lib/events";
import { tunnelList, tunnelStart, tunnelStop } from "../../lib/tauri";

function useActiveSession() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  return useMemo(
    () => tabs.find((t) => t.sessionId === activeSessionId) ?? null,
    [tabs, activeSessionId],
  );
}

type Row = { config: TunnelConfig; live?: TunnelStatus };

function localAddr(kind: TunnelType): string | null {
  switch (kind.type) {
    case "local": return `${kind.localHost}:${kind.localPort}`;
    case "remote": return null;
    case "dynamic": return `${kind.localHost}:${kind.localPort}`;
  }
}

export function TunnelsView() {
  const active = useActiveSession();
  const connections = useConnectionsStore((s) => s.items);
  const [live, setLive] = useState<TunnelStatus[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const configured: TunnelConfig[] = useMemo(() => {
    if (!active) return [];
    const conn = connections.find((c) => c.id === active.connectionId);
    return conn?.tunnels ?? [];
  }, [active, connections]);

  const refresh = useCallback(async (sessionId: string) => {
    try {
      const list = await tunnelList(sessionId);
      setLive(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!active || active.disconnected) {
      setLive([]);
      setError(null);
      return;
    }
    void refresh(active.sessionId);
  }, [active?.sessionId, active?.disconnected, refresh]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onTunnelStatus((ev) => {
      if (cancelled) return;
      if (!active || ev.sessionId !== active.sessionId) return;
      setLive((prev) => {
        const idx = prev.findIndex((t) => t.tunnelId === ev.tunnelId);
        if (ev.state === "stopped") return prev.filter((t) => t.tunnelId !== ev.tunnelId);
        if (idx < 0) return [...prev, ev];
        return prev.map((t) => (t.tunnelId === ev.tunnelId ? ev : t));
      });
    }).then((fn) => { unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, [active?.sessionId]);

  const rows: Row[] = useMemo(() => {
    const byId = new Map(live.map((t) => [t.tunnelId, t]));
    const fromConfig = configured.map((c) => ({ config: c, live: byId.get(c.id) }));
    const configIds = new Set(configured.map((c) => c.id));
    const extra = live.filter((t) => !configIds.has(t.tunnelId)).map((t) => ({
      config: { id: t.tunnelId, name: t.name, kind: t.kind, autoStart: t.autoStart },
      live: t,
    }));
    return [...fromConfig, ...extra];
  }, [configured, live]);

  async function onStart(config: TunnelConfig) {
    if (!active) return;
    setBusyId(config.id);
    try {
      await tunnelStart(active.sessionId, config);
      await refresh(active.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }

  async function onStop(tunnelId: string) {
    if (!active) return;
    setBusyId(tunnelId);
    try {
      await tunnelStop(active.sessionId, tunnelId);
      await refresh(active.sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusyId(null); }
  }

  if (!active) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-zinc-500">请先打开一个会话以管理隧道</p>
        </div>
      </div>
    );
  }

  if (active.disconnected) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-zinc-500">会话已断开，重连后可管理隧道</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500">
        会话：{active.name}
      </div>
      {error && (
        <p className="border-b border-zinc-800 bg-red-950/20 px-3 py-2 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-zinc-500">
            暂无隧道。在连接配置中添加端口转发
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2 space-y-2">
          {rows.map(({ config, live: st }) => {
            const running = st?.state === "running" || st?.state === "starting";
            const busy = busyId === config.id;
            const addr = localAddr(config.kind);

            return (
              <li key={config.id} className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Network className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      {(() => {
                        let color = "bg-zinc-700 text-zinc-300";
                        let label = "?";
                        switch (config.kind.type) {
                          case "local": color = "bg-sky-700/60 text-sky-200"; label = "L"; break;
                          case "remote": color = "bg-purple-700/60 text-purple-200"; label = "R"; break;
                          case "dynamic": color = "bg-emerald-700/60 text-emerald-200"; label = "D"; break;
                        }
                        return <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${color}`}>{label}</span>;
                      })()}
                      <span className="truncate text-sm font-medium text-zinc-200">
                        {config.name || "未命名隧道"}
                      </span>
                      {config.autoStart && (
                        <span className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">自动</span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                      {(() => {
                        switch (config.kind.type) {
                          case "local":  return `L  ${addr} → ${config.kind.remoteHost}:${config.kind.remotePort}`;
                          case "remote": return `R  ${config.kind.remoteHost}:${config.kind.remotePort} → ${config.kind.localHost}:${config.kind.localPort}`;
                          case "dynamic": return `D  SOCKS5 ${addr}`;
                        }
                      })()}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className={
                        st?.state === "running" ? "text-[11px] font-medium text-emerald-400" :
                        st?.state === "starting" ? "text-[11px] font-medium text-amber-400" :
                        st?.state === "error" ? "text-[11px] font-medium text-red-400" :
                        "text-[11px] text-zinc-500"
                      }>
                        {st?.state === "running" ? "●" : st?.state === "starting" ? "◐" : "○"} {stateLabel(st?.state ?? "stopped")}
                      </span>
                      {addr && (
                        <button
                          type="button"
                          title="复制本地地址到剪贴板"
                          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                          onClick={() => {
                            void navigator.clipboard.writeText(addr);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          }}
                        >
                          <Copy className="h-3 w-3" />
                          {copied ? "已复制" : addr}
                        </button>
                      )}
                    </div>
                    {st?.error && (
                      <p className="mt-1 text-[11px] text-red-400 break-words">{st.error}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1 pt-1">
                    {running ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onStop(config.id)}
                        className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                      >
                        <Square className="h-3 w-3" />
                        {busy ? "…" : "停止"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onStart(config)}
                        className="flex items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                      >
                        <Play className="h-3 w-3" />
                        {busy ? "…" : "启动"}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="border-b border-zinc-800 px-4 py-3">
      <h1 className="text-sm font-semibold tracking-wide text-zinc-200">隧道</h1>
    </div>
  );
}

function stateLabel(s: string): string {
  switch (s) {
    case "running": return "运行中";
    case "starting": return "启动中";
    case "stopped": return "已停止";
    case "error": return "错误";
    default: return s;
  }
}
