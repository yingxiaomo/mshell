import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  decodeTerminalOutputBytes,
  encodeTerminalInput,
  onTerminalOutput,
  setLiveTerminalForward,
  drainTerminalBuffer,
} from "../../lib/events";
import { terminalResize, terminalWrite } from "../../lib/tauri";
import type { TerminalTab } from "../../stores/sessions";
import { useSessionsStore } from "../../stores/sessions";

export type TerminalViewProps = {
  tab: TerminalTab;
  fontFamily?: string;
  fontSize?: number;
  /** Keep mounted but hidden when not the active tab. */
  active: boolean;
};

export function TerminalView({
  tab,
  fontFamily = "Cascadia Code, Consolas, monospace",
  fontSize = 14,
  active,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let onDataDisp: { dispose: () => void } | undefined;
    let onResizeDisp: { dispose: () => void } | undefined;
    let ro: ResizeObserver | undefined;
    let term: Terminal | null = null;

    // Subscribe to live terminal output first so we don't miss events
    // that arrive between subscribe and xterm creation.
    void (async () => {
      unlisten = await onTerminalOutput((ev) => {
        if (
          ev.sessionId !== tab.sessionId ||
          ev.channelId !== tab.channelId
        ) {
          return;
        }
        const bytes = decodeTerminalOutputBytes(ev.dataB64);
        // xterm not ready yet — output will be drained from early buffer.
        if (!termRef.current) {
          return;
        }
        termRef.current.write(bytes);
      });

      if (cancelled) {
        unlisten?.();
        return;
      }

      term = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily,
        fontSize,
        theme: {
          background: "#09090b",
          foreground: "#e4e4e7",
          cursor: "#e4e4e7",
          selectionBackground: "#3f3f46",
        },
      });
      const fit = new FitAddon();
      const searchAddon = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon());
      searchRef.current = searchAddon;
      term.open(el);
      try {
        fit.fit();
      } catch {
        /* ignore if zero-sized */
      }

      termRef.current = term;
      fitRef.current = fit;

      // Ctrl+F toggles search bar (intercepts before xterm processes it).
      term.attachCustomKeyEventHandler((e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "f") {
          setSearchVisible((v) => !v);
          return false;
        }
        return true;
      });

      // Drain events buffered globally before this TerminalView mounted.
      drainTerminalBuffer(tab.sessionId, (bytes) => {
        if (term) term.write(bytes);
      });

      onDataDisp = term.onData((data) => {
        const encoded = encodeTerminalInput(data);
        void terminalWrite(tab.sessionId, tab.channelId, encoded).catch(
          () => {},
        );
        // Broadcast to synced sessions (sync input).
        const targets = useSessionsStore
          .getState()
          .getSyncedTargets(tab.sessionId);
        for (const t of targets) {
          void terminalWrite(t.sessionId, t.channelId, encoded).catch(() => {});
        }
      });

      onResizeDisp = term.onResize(({ cols, rows }) => {
        void terminalResize(tab.sessionId, tab.channelId, cols, rows).catch(
          () => {},
        );
      });

      // First resize also signals the backend that the UI is ready.
      void terminalResize(
        tab.sessionId,
        tab.channelId,
        Math.max(term.cols, 80),
        Math.max(term.rows, 24),
      ).catch(() => {});

      // Ctrl+F / Ctrl+Shift+F handled via customKeyEventHandler in constructor opts.

      if (active) {
        term.focus();
      }

      // After we have xterm ready, switch the global buffer to forward
      // directly so events don't double-buffer.
      setLiveTerminalForward((ev) => {
        if (
          ev.sessionId !== tab.sessionId ||
          ev.channelId !== tab.channelId
        ) {
          return;
        }
        const bytes = decodeTerminalOutputBytes(ev.dataB64);
        termRef.current?.write(bytes);
      });

      ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* ignore if disposed */
        }
      });
      ro.observe(el);
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      unlisten?.();
      onDataDisp?.dispose();
      onResizeDisp?.dispose();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Mount once per tab identity; font props applied on first open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId, tab.channelId]);

  useEffect(() => {
    if (active) {
      // Refit when becoming visible (hidden tabs have zero size).
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          termRef.current?.focus();
        } catch {
          /* ignore */
        }
      });
    }
  }, [active]);

  return (
    <div className="relative h-full w-full min-h-0">
      <div
        className="h-full w-full min-h-0"
        style={{ display: active ? "block" : "none" }}
        ref={containerRef}
      />
      {active && searchVisible && (
        <div className="absolute left-2 right-2 top-2 z-10 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 shadow-lg">
          <input
            ref={searchInputRef}
            className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs text-zinc-100 outline-none"
            placeholder="搜索终端… (Enter=查找, Shift+Enter=上一个, Esc=关闭)"
            autoFocus
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              searchRef.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) {
                  searchRef.current?.findPrevious(searchText);
                } else {
                  searchRef.current?.findNext(searchText);
                }
              }
              if (e.key === "Escape") setSearchVisible(false);
            }}
          />
          <span className="text-[10px] text-zinc-500">
            <button
              type="button"
              className="rounded px-1 hover:bg-zinc-800"
              onClick={() => searchRef.current?.findPrevious(searchText)}
              title="上一个 (Shift+Enter)"
            >
              ▲
            </button>
            <button
              type="button"
              className="rounded px-1 hover:bg-zinc-800"
              onClick={() => searchRef.current?.findNext(searchText)}
              title="下一个 (Enter)"
            >
              ▼
            </button>
          </span>
          <button
            type="button"
            className="rounded px-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={() => setSearchVisible(false)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
