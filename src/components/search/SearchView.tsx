import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useSessionsStore } from "../../stores/sessions";
import { useUiStore } from "../../stores/ui";
import { cmd, commands } from "../../lib/commands";
import { showToast } from "../ui/Toast";

type SearchResult = {
  sessionId: string;
  sessionName: string;
  file: string;
  line: number;
  content: string;
};

type SessionSearch = {
  sessionId: string;
  name: string;
  checked: boolean;
};

export function SearchView() {
  const tabs = useSessionsStore((s) => s.tabs);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [searchers, setSearchers] = useState<SessionSearch[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Sync searcher list with tabs
  useEffect(() => {
    setSearchers((prev) => {
      const prevMap = new Map(prev.map((s) => [s.sessionId, s]));
      return tabs
        .filter((t) => !t.disconnected && !t.connecting)
        .map((t) => ({
          sessionId: t.sessionId,
          name: t.name,
          checked: prevMap.get(t.sessionId)?.checked ?? true,
        }));
    });
  }, [tabs]);

  const openEditor = useUiStore((s) => s.openEditor);

  const toggleSession = useCallback((sessionId: string) => {
    setSearchers((s) =>
      s.map((s) =>
        s.sessionId === sessionId ? { ...s, checked: !s.checked } : s,
      ),
    );
  }, []);

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    const targets = searchers.filter((s) => s.checked);
    if (targets.length === 0) {
      showToast("请至少选择一个会话", "info");
      return;
    }

    setSearching(true);
    setResults([]);
    setDone(false);

    // 单引号包裹查询和路径并转义单引号，防止 $()/反引号/双引号命令注入
    const safeQuery = q.replace(/'/g, "'\\''");
    const searchPath = (path.trim() || ".").replace(/'/g, "'\\''");
    // Use grep with recursive, line-number, suppress-error
    const command = `grep -rn '${safeQuery}' '${searchPath}' 2>/dev/null | head -100`;

    const allResults: SearchResult[] = [];
    for (const target of targets) {
      try {
        const output = await cmd(commands.sessionExec, {
          sessionId: target.sessionId,
          command,
        });
        if (!output) continue;
        for (const line of output.split("\n")) {
          if (!line) continue;
          // Parse: file:line:content
          const match = line.match(/^(.+?):(\d+):(.*)/);
          if (match) {
            allResults.push({
              sessionId: target.sessionId,
              sessionName: target.name,
              file: match[1]!,
              line: parseInt(match[2]!, 10),
              content: match[3]!,
            });
          }
        }
      } catch {
        // session disconnected or exec failed — skip
      }
    }
    setResults(allResults);
    setSearching(false);
    setDone(true);
  }, [query, path, searchers]);

  // Highlight the query in content (content is escaped first to prevent XSS)
  const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const highlight = useCallback(
    (text: string) => {
      if (!query.trim()) return escapeHtml(text);
      const escaped = escapeHtml(text);
      const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const parts = escaped.split(new RegExp(`(${pattern})`, "gi"));
      return parts.map((part) =>
        part.toLowerCase() === query.toLowerCase()
          ? `<mark class="bg-sky-600/40 text-zinc-100 rounded px-0.5">${part}</mark>`
          : part,
      ).join("");
    },
    [query],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">全文本搜索</h1>
      </div>

      {/* 搜索输入 */}
      <div className="border-b border-zinc-800 px-3 py-2 space-y-2">
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); } }}
            placeholder="搜索关键词（正则）…"
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          {query && (
            <button type="button" className="rounded p-0.5 text-zinc-500 hover:text-zinc-300" onClick={() => setQuery("")}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1">
          <span className="text-[10px] text-zinc-500">路径</span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder=".（默认当前目录）"
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </div>
      </div>

      {/* 会话选择 */}
      {searchers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-zinc-800 px-3 py-2">
          {searchers.map((s) => (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => toggleSession(s.sessionId)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                s.checked ? "bg-sky-600/20 text-sky-400" : "bg-zinc-800 text-zinc-500"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 搜索按钮 */}
      <div className="border-b border-zinc-800 px-3 py-2">
        <button
          type="button"
          disabled={searching || !query.trim()}
          onClick={() => void doSearch()}
          className="w-full rounded-md bg-sky-600 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {searching ? "搜索中…" : "搜索"}
        </button>
      </div>

      {/* 结果 */}
      <div className="flex-1 overflow-y-auto p-3">
        {!done && !searching && (
          <p className="text-center text-sm text-zinc-500 py-8">
            输入关键词，选择一个或多个会话，点击搜索
          </p>
        )}

        {searching && (
          <p className="text-center text-sm text-sky-400 py-8">正在搜索…</p>
        )}

        {done && results.length === 0 && (
          <p className="text-center text-sm text-zinc-500 py-8">未找到匹配结果</p>
        )}

        {results.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-500">
              找到 {results.length} 处匹配
            </p>
            {(() => {
              // Group by session
              const groups = new Map<string, SearchResult[]>();
              for (const r of results) {
                const key = `${r.sessionName} (${r.sessionId.slice(0, 8)})`;
                let list = groups.get(key);
                if (!list) { list = []; groups.set(key, list); }
                list.push(r);
              }
              return Array.from(groups.entries()).map(([sessionLabel, sessionResults]) => (
                <div key={sessionLabel}>
                  <p className="mb-1 text-[11px] font-medium text-zinc-400">{sessionLabel}</p>
                  {sessionResults.map((r, i) => (
                    <div key={`${r.sessionId}-${r.file}-${r.line}-${i}`}
                      className="mb-0.5 rounded border-l-2 border-zinc-700 bg-zinc-900/40 px-2 py-1 hover:border-sky-600 cursor-pointer"
                      onClick={() => {
                        const path = r.file.startsWith("/") ? r.file : `./${r.file}`;
                        openEditor({
                          sessionId: r.sessionId,
                          remotePath: path,
                          name: r.file.split("/").pop() || r.file,
                          gotoLine: r.line,
                        });
                        showToast(`已打开 ${r.file}:${r.line}`, "info");
                      }}
                      title={`点击在编辑器中打开 ${r.file}:${r.line}`}
                    >
                      <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                        <span className="truncate">{r.file}:{r.line}</span>
                      </div>
                      <div
                        className="mt-0.5 font-mono text-[11px] text-zinc-300 truncate"
                        dangerouslySetInnerHTML={{ __html: highlight(r.content) }}
                      />
                    </div>
                  ))}
                </div>
              ));
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
