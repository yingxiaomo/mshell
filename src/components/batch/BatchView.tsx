import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, Play } from "lucide-react";
import { useSessionsStore } from "../../stores/sessions";
import { cmd, commands } from "../../lib/commands";
import { showToast } from "../ui/Toast";

type BatchResult = {
  sessionId: string;
  sessionName: string;
  output: string;
  error?: string;
  running: boolean;
  done: boolean;
};

export function BatchView() {
  const tabs = useSessionsStore((s) => s.tabs);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<BatchResult[]>([]);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // 默认选中所有活跃会话
  const activeSessions = tabs.filter((t) => !t.disconnected && !t.connecting);
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const t of activeSessions) next.add(t.sessionId);
      return next;
    });
  }, [tabs]);

  const toggle = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const execute = useCallback(async () => {
    const cmdText = query.trim();
    if (!cmdText) return;
    const targets = activeSessions.filter((t) => selected.has(t.sessionId));
    if (targets.length === 0) { showToast("请至少选择一个会话", "info"); return; }

    setRunning(true);
    setResults(targets.map((t) => ({
      sessionId: t.sessionId,
      sessionName: t.name,
      output: "",
      running: true,
      done: false,
    })));

    for (const target of targets) {
      try {
        const output = await cmd(commands.sessionExec, {
          sessionId: target.sessionId,
          command: cmdText,
        });
        setResults((prev) => prev.map((r) =>
          r.sessionId === target.sessionId
            ? { ...r, output: output || "(无输出)", running: false, done: true }
            : r,
        ));
      } catch (e) {
        setResults((prev) => prev.map((r) =>
          r.sessionId === target.sessionId
            ? { ...r, error: e instanceof Error ? e.message : String(e), running: false, done: true }
            : r,
        ));
      }
    }
    setRunning(false);
  }, [query, selected, activeSessions]);

  const clearResults = useCallback(() => setResults([]), []);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">集群命令</h1>
      </div>

      {/* 会话选择 */}
      <div className="border-b border-zinc-800 px-3 py-2">
        <p className="mb-1.5 text-[11px] text-zinc-500">目标会话</p>
        <div className="flex flex-wrap gap-1.5">
          {activeSessions.length === 0 && (
            <p className="text-xs text-zinc-600">没有活跃的会话</p>
          )}
          {activeSessions.map((t) => (
            <button
              key={t.sessionId}
              type="button"
              onClick={() => toggle(t.sessionId)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                selected.has(t.sessionId) ? "bg-sky-600/20 text-sky-400" : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {/* 命令输入 */}
      <div className="border-b border-zinc-800 px-3 py-2">
        <textarea
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void execute(); }
            if (e.key === "Escape") { e.currentTarget.blur(); }
          }}
          placeholder="输入命令（Ctrl+Enter 执行）…"
          rows={3}
          className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={running || !query.trim() || selected.size === 0}
            onClick={() => void execute()}
            className="flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {running ? "执行中…" : `执行 (${selected.size} 个会话)`}
          </button>
          {results.length > 0 && (
            <button type="button" onClick={clearResults} className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300">清除</button>
          )}
        </div>
      </div>

      {/* 结果 */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {results.length === 0 && (
          <p className="text-center text-sm text-zinc-500 py-8">选择一个或多个会话，输入命令后执行</p>
        )}
        {results.map((r) => (
          <div key={r.sessionId} className="rounded-md border border-zinc-800 bg-zinc-900/60">
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-300">
                <Terminal className="h-3.5 w-3.5 text-zinc-500" />
                {r.sessionName}
              </span>
              <span className={`text-[10px] ${r.running ? "text-sky-400" : r.error ? "text-red-400" : "text-emerald-500"}`}>
                {r.running ? "执行中…" : r.error ? "失败" : "完成"}
              </span>
            </div>
            <pre className="max-h-48 overflow-auto p-3 font-mono text-[11px] text-zinc-300 whitespace-pre-wrap break-all">
              {r.running && "等待响应…"}
              {r.done && !r.error && (r.output || "(空)")}
              {r.error && <span className="text-red-400">{r.error}</span>}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
