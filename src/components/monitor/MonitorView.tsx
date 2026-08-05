import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Cpu, HardDrive, Wifi } from "lucide-react";
import { cmd, commands } from "../../lib/commands";
import { useSessionsStore } from "../../stores/sessions";

type MonData = {
  /** CPU load 1/5/15 min */
  load: [number, number, number];
  /** cpu usage percent (0-100), or null until two samples seen */
  cpu: number | null;
  /** mem total, used */
  mem: { total: number; used: number };
  /** disk / total, used */
  disk: { total: number; used: number };
  /** net rx/tx bytes/sec */
  net: { rx: number; tx: number };
  /** swap total, used */
  swap: { total: number; used: number };
  /** uptime seconds */
  uptime: number;
  /** cpu core count */
  cores: number;
};

type ProcRow = { pid: number; cpu: number; mem: number; name: string };

/** Parse first line of /proc/stat → busy/idle jiffies for CPU% deltas. */
function parseCpuStat(raw: string): { total: number; idle: number } | null {
  const line = raw.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const nums = line.trim().split(/\s+/).slice(1).map((n) => parseInt(n, 10) || 0);
  if (nums.length < 5) return null;
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
  const total = nums.reduce((a, b) => a + b, 0);
  return { total, idle };
}

/** Parse `ps -eo pid,pcpu,pmem,comm --sort=-pcpu` output (empty on busybox). */
function parseProcs(raw: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim().split(/\s+/);
    if (t.length < 4) continue;
    const pid = parseInt(t[0]!, 10);
    if (!Number.isFinite(pid)) continue; // skips the "PID %CPU …" header
    out.push({
      pid,
      cpu: parseFloat(t[1]!) || 0,
      mem: parseFloat(t[2]!) || 0,
      name: t.slice(3).join(" "),
    });
  }
  return out;
}

function parseLoadAvg(raw: string): [number, number, number] {
  const parts = raw.trim().split(/\s+/);
  return [
    parseFloat(parts[0] ?? "0") || 0,
    parseFloat(parts[1] ?? "0") || 0,
    parseFloat(parts[2] ?? "0") || 0,
  ];
}

/** Parse /proc/meminfo (BusyBox & GNU compatible). Also extracts swap. */
function parseMeminfo(raw: string): { total: number; used: number; swapTotal: number; swapFree: number } {
  let total = 0, free = 0, swapTotal = 0, swapFree = 0;
  for (const line of raw.split("\n")) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (!parts[1]) continue;
    const val = parseInt(parts[1], 10) * 1024; // kB → bytes
    if (parts[0]?.startsWith("MemTotal:")) total = val || 0;
    if (parts[0]?.startsWith("MemAvailable:")) free = val || 0;
    if (!free && parts[0]?.startsWith("MemFree:")) free = val || 0;
    if (parts[0]?.startsWith("SwapTotal:")) swapTotal = val || 0;
    if (parts[0]?.startsWith("SwapFree:")) swapFree = val || 0;
  }
  return { total, used: Math.max(0, total - free), swapTotal, swapFree };
}

/** Parse `df -k /` output (single line like "185720 92372"). */
function parseDf(raw: string): { total: number; used: number } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const blocks = parseInt(parts[0] ?? "0", 10) * 1024 || 0;
  const used = parseInt(parts[1] ?? "0", 10) * 1024 || 0;
  return { total: blocks, used };
}

function parseNet(raw: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    if (parts[0] === "Inter-|" || parts[0] === "face" || parts[0] === "lo:") continue;
    const name = parts[0]!.replace(":", "");
    if (name === "lo") continue;
    rx += parseInt(parts[1] ?? "0", 10) || 0;
    tx += parseInt(parts[9] ?? "0", 10) || 0;
  }
  return { rx, tx };
}

/** Parse `cat /proc/uptime` → seconds. */
function parseUptime(raw: string): number {
  const parts = raw.trim().split(/\s+/);
  return parseFloat(parts[0] ?? "0") || 0;
}

/** Format seconds → human readable. */
function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function pct(a: number, b: number): string {
  if (b <= 0) return "0";
  return ((a / b) * 100).toFixed(1);
}

export function MonitorView() {
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const active = tabs.find((t) => t.sessionId === activeSessionId);

  const [data, setData] = useState<MonData | null>(null);
  const [procs, setProcs] = useState<ProcRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prevRef = useRef<{ rx: number; tx: number; time: number } | null>(null);
  const prevCpuRef = useRef<{ total: number; idle: number } | null>(null);
  const cpuHistRef = useRef<number[]>([]);
  const memHistRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-entrancy guard: skip a poll if the previous one is still in flight
  // (a slow/hung host must not pile up overlapping execs).
  const runningRef = useRef(false);
  // Set true by the effect cleanup so a late-resolving poll after unmount /
  // session switch doesn't write another host's metrics into state.
  const cancelledRef = useRef(false);
  // Exponential backoff for consecutive failures (3s → 6s → 12s → 15s cap).
  const failCountRef = useRef(0);

  const fetchStats = useCallback(async () => {
    if (!active || active.disconnected) return;
    if (runningRef.current) return;
    runningRef.current = true;
    const sid = active.sessionId;
    // A poll is stale if the effect was torn down, or the active session
    // changed, while its exec was in flight.
    const isStale = () =>
      cancelledRef.current ||
      useSessionsStore.getState().activeSessionId !== sid;
    try {
      const combined = await cmd(commands.sessionExec, {
        sessionId: active.sessionId,
        command:
          "echo '===LOADAVG==='; cat /proc/loadavg;" +
          "echo '===MEMINFO==='; cat /proc/meminfo;" +
          "echo '===DFROOT==='; df -k / | tail -n 1 | tr -s ' ' | cut -d' ' -f2,3;" +
          "echo '===NETDEV==='; cat /proc/net/dev;" +
          "echo '===UPTIME==='; cat /proc/uptime;" +
          "echo '===CPUINFO==='; grep -c ^processor /proc/cpuinfo || echo 1;" +
          "echo '===CPUSTAT==='; head -1 /proc/stat;" +
          "echo '===PROCS==='; ps -eo pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 11",
      }).catch((e) => {
        // 会话 worker 已死 → 标记断开，停止轮询
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("reply channel closed") || msg.includes("session worker") || msg.includes("session not found")) {
          useSessionsStore.getState().markDisconnected(active.sessionId, "会话已断开（监控检测）");
        }
        return "";
      });

      if (isStale()) return;

      const part = (marker: string) => {
        const idx = combined.indexOf(marker);
        if (idx < 0) return "";
        const start = idx + marker.length;
        const end = combined.indexOf("===", start);
        return (end < 0 ? combined.slice(start) : combined.slice(start, end)).trim();
      };

      const loadStr = part("===LOADAVG===");
      const memStr = part("===MEMINFO===");
      const diskStr = part("===DFROOT===");
      const netStr = part("===NETDEV===");
      const uptimeStr = part("===UPTIME===");
      const coresStr = part("===CPUINFO===");

      const load = parseLoadAvg(loadStr);
      const memInfo = parseMeminfo(memStr);
      const disk = parseDf(diskStr);
      const netCurr = parseNet(netStr);
      const now = Date.now();

      // CPU% from /proc/stat deltas (null until the second sample).
      const cpuStat = parseCpuStat(part("===CPUSTAT==="));
      let cpuPct: number | null = null;
      if (cpuStat && prevCpuRef.current) {
        const dTotal = cpuStat.total - prevCpuRef.current.total;
        const dIdle = cpuStat.idle - prevCpuRef.current.idle;
        if (dTotal > 0) cpuPct = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
      }
      if (cpuStat) prevCpuRef.current = cpuStat;

      const HIST = 40;
      if (cpuPct != null) cpuHistRef.current = [...cpuHistRef.current, cpuPct].slice(-HIST);
      const memPct = memInfo.total > 0 ? (memInfo.used / memInfo.total) * 100 : 0;
      memHistRef.current = [...memHistRef.current, memPct].slice(-HIST);
      setProcs(parseProcs(part("===PROCS===")));

      let rx = 0;
      let tx = 0;
      if (prevRef.current) {
        const dt = (now - prevRef.current.time) / 1000;
        if (dt > 0) {
          rx = Math.max(0, (netCurr.rx - prevRef.current.rx) / dt);
          tx = Math.max(0, (netCurr.tx - prevRef.current.tx) / dt);
        }
      }
      prevRef.current = { rx: netCurr.rx, tx: netCurr.tx, time: now };

      setData({
        load, cpu: cpuPct, mem: { total: memInfo.total, used: memInfo.used },
        disk, net: { rx, tx },
        swap: { total: memInfo.swapTotal, used: memInfo.swapTotal - memInfo.swapFree },
        uptime: parseUptime(uptimeStr),
        cores: parseInt(coresStr.trim(), 10) || 0,
      });
      setError(null);
    } catch (e) {
      if (isStale()) return;
      setError(e instanceof Error ? e.message : String(e));
      failCountRef.current += 1;
      return; // don't update data on failure
    } finally {
      runningRef.current = false;
    }
    failCountRef.current = 0;
  }, [active?.sessionId, active?.disconnected]);

  useEffect(() => {
    if (!active || active.disconnected) {
      setData(null);
      setProcs([]);
      setError(null);
      return;
    }
    cancelledRef.current = false;
    // Fresh baselines for the newly-active session.
    prevCpuRef.current = null;
    cpuHistRef.current = [];
    memHistRef.current = [];
    failCountRef.current = 0;
    // Delay first poll to let the terminal settle after connect.
    // Use recursive setTimeout (not setInterval) so the gap between polls is always
    // from completion, not from start — prevents pileup on slow connections.
    // Exponential backoff: 3s → 6s → 12s → caps at 15s, resets on success.
    const schedule = () => {
      const baseMs = 3000;
      const delay = Math.min(baseMs * 2 ** failCountRef.current, 15000);
      timerRef.current = setTimeout(async () => {
        await fetchStats();
        if (!cancelledRef.current) schedule();
      }, delay);
    };
    const initialTimer = setTimeout(() => {
      void fetchStats().then(() => {
        if (!cancelledRef.current) schedule();
      });
    }, 3000);
    return () => {
      cancelledRef.current = true;
      clearTimeout(initialTimer);
      if (timerRef.current) clearTimeout(timerRef.current);
      prevRef.current = null;
    };
  }, [active?.sessionId, active?.disconnected, fetchStats]);

  async function killProc(pid: number, name: string) {
    if (!active) return;
    if (!window.confirm(`结束进程 ${pid}（${name}）？`)) return;
    try {
      await cmd(commands.sessionExec, { sessionId: active.sessionId, command: `kill ${pid}` });
      setProcs((p) => p.filter((r) => r.pid !== pid));
      void fetchStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!active) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-sm text-zinc-500">请先打开一个会话</p>
        </div>
      </div>
    );
  }

  if (active.disconnected) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-sm text-amber-500/90">会话已断开</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">
        会话：{active.name} · 每 3 秒刷新
      </div>
      {error && (
        <div className="border-b border-red-900/40 bg-red-950/30 px-3 py-1.5 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        <Card icon={<Cpu className="h-4 w-4" />} label="CPU">
          {data ? (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-lg text-zinc-100">
                  {data.cpu != null ? `${data.cpu.toFixed(0)}%` : "—"}
                </span>
                <span className="text-[11px] text-zinc-500">
                  负载 {data.load[0].toFixed(2)} / {data.load[1].toFixed(2)} / {data.load[2].toFixed(2)}
                </span>
              </div>
              <Sparkline data={cpuHistRef.current} color="#38bdf8" />
            </div>
          ) : (
            <p className="text-xs text-zinc-500">加载中…</p>
          )}
        </Card>

        <Card icon={<Cpu className="h-4 w-4" />} label="系统">
          {data ? (
            <div className="space-y-1 text-xs text-zinc-400">
              <div className="flex justify-between">
                <span>运行时间</span>
                <span className="font-mono text-zinc-100">{fmtDuration(data.uptime)}</span>
              </div>
              <div className="flex justify-between">
                <span>CPU 核心</span>
                <span className="font-mono text-zinc-100">{data.cores}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">加载中…</p>
          )}
        </Card>

        <Card icon={<Activity className="h-4 w-4" />} label="内存">
          {data ? (
            <div className="space-y-2">
              <Bar value={data.mem.used} max={data.mem.total} color="sky" />
              <div className="flex justify-between text-xs text-zinc-500">
                <span>已用 {fmtBytes(data.mem.used)}</span>
                <span>{pct(data.mem.used, data.mem.total)}%</span>
                <span>总量 {fmtBytes(data.mem.total)}</span>
              </div>
              <Sparkline data={memHistRef.current} color="#a78bfa" />
              {data.swap.total > 0 && (
                <>
                  <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
                    <span>Swap</span>
                    <span>{pct(data.swap.used, data.swap.total)}%</span>
                  </div>
                  <Bar value={data.swap.used} max={data.swap.total} color="sky" />
                </>
              )}
            </div>
          ) : (
            <p className="text-xs text-zinc-500">加载中…</p>
          )}
        </Card>

        <Card icon={<HardDrive className="h-4 w-4" />} label="磁盘 /">
          {data ? (
            <div className="space-y-2">
              <Bar value={data.disk.used} max={data.disk.total} color="amber" />
              <div className="flex justify-between text-xs text-zinc-500">
                <span>已用 {fmtBytes(data.disk.used)}</span>
                <span>{pct(data.disk.used, data.disk.total)}%</span>
                <span>总量 {fmtBytes(data.disk.total)}</span>
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">加载中…</p>
          )}
        </Card>

        <Card icon={<Wifi className="h-4 w-4" />} label="网络">
          {data ? (
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>⬇ 接收</span>
                  <span className="font-mono text-zinc-100">{fmtBytes(data.net.rx)}/s</span>
                </div>
                <Bar value={data.net.rx} max={Math.max(data.net.rx * 4, 1024 * 1024)} color="green" />
              </div>
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>⬆ 发送</span>
                  <span className="font-mono text-zinc-100">{fmtBytes(data.net.tx)}/s</span>
                </div>
                <Bar value={data.net.tx} max={Math.max(data.net.tx * 4, 1024 * 1024)} color="purple" />
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">加载中…</p>
          )}
        </Card>

        <Card icon={<Activity className="h-4 w-4" />} label="进程（按 CPU）">
          {procs.length === 0 ? (
            <p className="text-xs text-zinc-500">
              {data ? "暂无数据（该系统的 ps 可能不支持排序列）" : "加载中…"}
            </p>
          ) : (
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 px-1 text-[10px] text-zinc-600">
                <span className="w-14">PID</span>
                <span className="w-10 text-right">CPU%</span>
                <span className="w-10 text-right">MEM%</span>
                <span className="flex-1">命令</span>
                <span className="w-6" />
              </div>
              {procs.map((p) => (
                <div key={p.pid} className="group flex items-center gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-zinc-800/60">
                  <span className="w-14 font-mono text-zinc-500">{p.pid}</span>
                  <span className="w-10 text-right font-mono text-zinc-200">{p.cpu.toFixed(1)}</span>
                  <span className="w-10 text-right font-mono text-zinc-400">{p.mem.toFixed(1)}</span>
                  <span className="flex-1 truncate text-zinc-300" title={p.name}>{p.name}</span>
                  <button
                    type="button"
                    className="w-6 shrink-0 rounded text-zinc-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
                    title="结束进程 (kill)"
                    onClick={() => void killProc(p.pid, p.name)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Tiny inline sparkline for a 0-100 percentage history. */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 200;
  const h = 32;
  if (data.length < 2) return <div className="h-8" aria-hidden />;
  const step = w / (data.length - 1);
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (Math.min(100, Math.max(0, v)) / 100) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-8 w-full">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Header() {
  return (
    <div className="border-b border-zinc-800 px-4 py-3">
      <h1 className="text-sm font-semibold tracking-wide text-zinc-200">监控</h1>
    </div>
  );
}

function Card({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-400">
        {icon}
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

const BAR_COLORS: Record<string, string> = {
  sky: "bg-sky-500",
  amber: "bg-amber-500",
  green: "bg-emerald-500",
  purple: "bg-purple-500",
};

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
      <div
        className={`h-full rounded-full transition-all duration-700 ${BAR_COLORS[color] ?? "bg-sky-500"}`}
        style={{ width: `${p}%` }}
      />
    </div>
  );
}
