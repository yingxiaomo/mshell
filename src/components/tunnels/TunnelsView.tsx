import { useCallback, useEffect, useMemo, useState } from "react";
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

function kindLabel(kind: TunnelType): string {
  switch (kind.type) {
    case "local":
      return `L ${kind.localHost}:${kind.localPort} → ${kind.remoteHost}:${kind.remotePort}`;
    case "remote":
      return `R ${kind.remoteHost}:${kind.remotePort} → ${kind.localHost}:${kind.localPort}`;
    case "dynamic":
      return `D SOCKS5 ${kind.localHost}:${kind.localPort}`;
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "running":
      return "运行中";
    case "starting":
      return "启动中";
    case "stopped":
      return "已停止";
    case "error":
      return "错误";
    default:
      return state;
  }
}

function stateClass(state: string): string {
  switch (state) {
    case "running":
      return "text-emerald-400";
    case "error":
      return "text-red-400";
    case "starting":
      return "text-amber-400";
    default:
      return "text-zinc-500";
  }
}

/** Merge configured connection tunnels with live runtime statuses. */
type Row = {
  config: TunnelConfig;
  live?: TunnelStatus;
};

export function TunnelsView() {
  const active = useActiveSession();
  const connections = useConnectionsStore((s) => s.items);
  const [live, setLive] = useState<TunnelStatus[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
      setActionError(null);
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
        if (ev.state === "stopped") {
          return prev.filter((t) => t.tunnelId !== ev.tunnelId);
        }
        if (idx < 0) return [...prev, ev];
        return prev.map((t) => (t.tunnelId === ev.tunnelId ? ev : t));
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active?.sessionId]);

  const rows: Row[] = useMemo(() => {
    const byId = new Map(live.map((t) => [t.tunnelId, t]));
    const fromConfig: Row[] = configured.map((config) => ({
      config,
      live: byId.get(config.id),
    }));
    // Ephemeral tunnels started only at runtime (not on connection).
    const configIds = new Set(configured.map((c) => c.id));
    const extra: Row[] = live
      .filter((t) => !configIds.has(t.tunnelId))
      .map((t) => ({
        config: {
          id: t.tunnelId,
          name: t.name,
          kind: t.kind,
          autoStart: t.autoStart,
        },
        live: t,
      }));
    return [...fromConfig, ...extra];
  }, [configured, live]);

  async function onStart(config: TunnelConfig) {
    if (!active) return;
    setBusyId(config.id);
    setActionError(null);
    try {
      await tunnelStart(active.sessionId, config);
      await refresh(active.sessionId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onStop(tunnelId: string) {
    if (!active) return;
    setBusyId(tunnelId);
    setActionError(null);
    try {
      await tunnelStop(active.sessionId, tunnelId);
      await refresh(active.sessionId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (!active) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-zinc-500">
            请先打开一个会话以管理隧道
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
          <p className="text-center text-sm text-zinc-500">
            会话已断开，重连后可管理隧道
          </p>
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
      {(error || actionError) && (
        <p className="border-b border-zinc-800 px-3 py-2 text-xs text-red-400" role="alert">
          {actionError ?? error}
        </p>
      )}
      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-sm text-zinc-500">
            暂无隧道。在连接配置中添加端口转发
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto p-2">
          {rows.map(({ config, live: st }) => {
            const running = st?.state === "running" || st?.state === "starting";
            const busy = busyId === config.id;
            return (
              <li
                key={config.id}
                className="mb-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-zinc-200">
                      {config.name || "未命名隧道"}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-500">
                      {kindLabel(config.kind)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className={stateClass(st?.state ?? "stopped")}>
                        {stateLabel(st?.state ?? "stopped")}
                      </span>
                      {config.autoStart && (
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                          自动启动
                        </span>
                      )}
                    </div>
                    {st?.error && (
                      <p className="mt-1 text-[11px] text-red-400">{st.error}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      running ? void onStop(config.id) : void onStart(config)
                    }
                    className={
                      running
                        ? "shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        : "shrink-0 rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    }
                  >
                    {busy ? "…" : running ? "停止" : "启动"}
                  </button>
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
