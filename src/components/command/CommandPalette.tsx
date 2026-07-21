import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  File,
  Folder,
  Network,
  Server,
  Settings,
  Terminal,
  Zap,
} from "lucide-react";
import type { Connection, SideViewId } from "../../types/protocol";
import {
  clientErrorMessage,
  parseClientError,
} from "../../types/protocol";
import { useConnectionsStore } from "../../stores/connections";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useSnippetsStore } from "../../stores/snippets";
import { useUiStore } from "../../stores/ui";
import { sessionOpen } from "../../lib/tauri";
import { showToast } from "../ui/Toast";
import { estimateTerminalGeometry } from "../../lib/terminalGeometry";

type CommandKind = "connection" | "view" | "action" | "snippet";

type CommandItem = {
  id: string;
  kind: CommandKind;
  title: string;
  subtitle?: string;
  keywords?: string;
  run: () => void | Promise<void>;
};

function scoreMatch(query: string, ...fields: (string | undefined)[]): number {
  if (!query) return 1;
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const hay = fields.filter(Boolean).join("\n").toLowerCase();
  if (!hay.includes(q) && !q.split(/\s+/).every((p) => hay.includes(p))) {
    return 0;
  }
  const title = (fields[0] ?? "").toLowerCase();
  if (title.startsWith(q)) return 100;
  if (title.includes(q)) return 80;
  return 50;
}

const VIEW_ITEMS: {
  id: SideViewId;
  title: string;
  subtitle: string;
  Icon: typeof Server;
}[] = [
  { id: "sessions", title: "侧栏：连接", subtitle: "Sessions", Icon: Server },
  { id: "files", title: "侧栏：文件", subtitle: "SFTP", Icon: Folder },
  { id: "tunnels", title: "侧栏：隧道", subtitle: "Tunnels", Icon: Network },
  { id: "settings", title: "侧栏：设置", subtitle: "Settings", Icon: Settings },
];

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const allConnections = useConnectionsStore((s) => s.all);
  const items = useConnectionsStore((s) => s.items);
  const imported = useConnectionsStore((s) => s.imported);
  const loadConnections = useConnectionsStore((s) => s.load);
  const reloadQuiet = useConnectionsStore((s) => s.reloadQuiet);

  const addTab = useSessionsStore((s) => s.addTab);
  const setOpening = useSessionsStore((s) => s.setOpening);
  const setOpenError = useSessionsStore((s) => s.setOpenError);
  const opening = useSessionsStore((s) => s.opening);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const tabs = useSessionsStore((s) => s.tabs);

  const switchToFilesOnOpen = useSettingsStore(
    (s) => s.settings.switchToFilesOnOpen,
  );
  const patchSettings = useSettingsStore((s) => s.patch);
  const theme = useSettingsStore((s) => s.settings.theme);

  const snippets = useSnippetsStore((s) => s.items);
  const runSnippet = useSnippetsStore((s) => s.run);
  const loadSnippets = useSnippetsStore((s) => s.load);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    void loadConnections();
    loadSnippets();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, loadConnections, loadSnippets]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "p" && k !== "k") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [setOpen]);

  const openConnection = useCallback(
    async (connection: Connection) => {
      if (connection.source?.type === "sshConfig") {
        showToast("导入的 ssh config 主机为只读，请先「复制为本地」再连接。", "error");
        return;
      }
      if (opening || busy) return;
      setBusy(true);
      setOpening(true);
      setOpenError(null);
      try {
        const { cols, rows } = estimateTerminalGeometry();
        const result = await sessionOpen(connection.id, cols, rows);
        addTab(result);
        void reloadQuiet();
        if (switchToFilesOnOpen) setActiveView("files");
        setOpen(false);
      } catch (e) {
        const cerr = parseClientError(e);
        setOpenError(clientErrorMessage(cerr));
        setOpen(false);
      } finally {
        setOpening(false);
        setBusy(false);
      }
    },
    [
      opening,
      busy,
      setOpening,
      setOpenError,
      addTab,
      reloadQuiet,
      switchToFilesOnOpen,
      setActiveView,
      setOpen,
    ],
  );

  const connections = useMemo(() => {
    void items;
    void imported;
    return allConnections();
  }, [allConnections, items, imported]);

  const commands = useMemo(() => {
    const list: CommandItem[] = [];

    for (const c of connections) {
      if (c.source?.type === "sshConfig") continue;
      list.push({
        id: `conn:${c.id}`,
        kind: "connection",
        title: c.name,
        subtitle: `${c.username}@${c.host}:${c.port}${c.group ? ` · ${c.group}` : ""}`,
        keywords: [c.host, c.username, c.group ?? "", ...(c.tags ?? [])].join(
          " ",
        ),
        run: () => openConnection(c),
      });
    }

    for (const v of VIEW_ITEMS) {
      list.push({
        id: `view:${v.id}`,
        kind: "view",
        title: v.title,
        subtitle: v.subtitle,
        keywords: v.id,
        run: () => {
          setActiveView(v.id);
          setOpen(false);
        },
      });
    }

    for (const sn of snippets) {
      list.push({
        id: `snip:${sn.id}`,
        kind: "snippet",
        title: sn.name,
        subtitle: sn.body.slice(0, 100),
        keywords: ["命令", "快捷", sn.body].join(" "),
        run: async () => {
          await runSnippet(sn.body);
          setOpen(false);
        },
      });
    }

    list.push({
      id: "action:toggle-theme",
      kind: "action",
      title: theme === "light" ? "切换到深色外观" : "切换到浅色外观",
      subtitle: "应用外观",
      keywords: "theme dark light 主题",
      run: async () => {
        await patchSettings({ theme: theme === "light" ? "dark" : "light" });
        setOpen(false);
      },
    });

    if (activeSessionId) {
      const tab = tabs.find((t) => t.sessionId === activeSessionId);
      list.push({
        id: "action:focus-files",
        kind: "action",
        title: "打开文件侧栏（当前会话）",
        subtitle: tab?.name,
        keywords: "sftp files 文件",
        run: () => {
          setActiveView("files");
          setOpen(false);
        },
      });
    }

    return list;
  }, [
    connections,
    openConnection,
    setActiveView,
    setOpen,
    theme,
    patchSettings,
    activeSessionId,
    tabs,
    snippets,
    runSnippet,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim();
    const scored = commands
      .map((c) => ({
        c,
        s: scoreMatch(q, c.title, c.subtitle, c.keywords),
      }))
      .filter((x) => x.s > 0)
      .sort((a, b) => {
        if (b.s !== a.s) return b.s - a.s;
        if (q && a.c.kind !== b.c.kind) {
          if (a.c.kind === "connection") return -1;
          if (b.c.kind === "connection") return 1;
        }
        return a.c.title.localeCompare(b.c.title);
      });
    return scored.map((x) => x.c);
  }, [commands, query]);

  useEffect(() => {
    setIndex(0);
  }, [query, open]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-index="${index}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [index, filtered.length]);

  const runSelected = useCallback(async () => {
    const item = filtered[index];
    if (!item || busy) return;
    setBusy(true);
    try {
      await item.run();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [filtered, index, busy]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[500] flex items-start justify-center bg-black/50 pt-[12vh] px-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl ring-1 ring-black/30"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2.5">
          <Terminal className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            placeholder="搜索连接、命令…"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) =>
                  Math.min(i + 1, Math.max(filtered.length - 1, 0)),
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                void runSelected();
              }
            }}
          />
          <kbd className="hidden shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-500 sm:inline">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-auto py-1">
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-zinc-500">
              无匹配结果
            </p>
          )}
          {filtered.map((cmd, i) => {
            const selected = i === index;
            const Icon =
              cmd.kind === "connection"
                ? Server
                : cmd.kind === "snippet"
                  ? Zap
                  : cmd.kind === "view"
                    ? cmd.id.includes("files")
                      ? Folder
                      : cmd.id.includes("tunnels")
                        ? Network
                        : cmd.id.includes("settings")
                          ? Settings
                          : Server
                    : File;
            return (
              <button
                key={cmd.id}
                type="button"
                data-cmd-index={i}
                className={
                  selected
                    ? "flex w-full items-center gap-2 bg-sky-600/20 px-3 py-2 text-left text-sm text-zinc-100"
                    : "flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800/80"
                }
                onMouseEnter={() => setIndex(i)}
                onClick={() => void runSelected()}
              >
                <Icon className="h-4 w-4 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{cmd.title}</span>
                  {cmd.subtitle && (
                    <span className="block truncate text-[11px] text-zinc-500">
                      {cmd.subtitle}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-600">
                  {cmd.kind === "connection"
                    ? "连接"
                    : cmd.kind === "view"
                      ? "视图"
                      : cmd.kind === "snippet"
                        ? "命令"
                        : "操作"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-600">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Ctrl+P 打开</span>
        </div>
      </div>
    </div>
  );
}
