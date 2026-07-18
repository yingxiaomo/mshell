import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  clearTerminalBuffers,
  consumeTerminalOutput,
  encodeTerminalInput,
  replayTerminalHistory,
} from "../../lib/events";
import { terminalWrite, terminalResize } from "../../lib/tauri";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { terminalThemeForChrome } from "../../lib/themes";
import { registerTerminalFind } from "../../lib/findHotkey";
import type { TerminalTab } from "../../stores/sessions";

export type TerminalViewProps = {
  tab: TerminalTab;
  fontFamily?: string;
  fontSize?: number;
  active: boolean;
};

export function TerminalView({
  tab,
  fontFamily = "monospace",
  fontSize = 14,
  active,
}: TerminalViewProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");

  const appTheme = useSettingsStore((s) => s.settings.theme);
  const settingsFont = useSettingsStore((s) => s.settings.terminalFont);
  const settingsFontSize = useSettingsStore(
    (s) => s.settings.terminalFontSize,
  );
  const copyOnSelect = useSettingsStore((s) => s.settings.copyOnSelect);
  const scrollback = useSettingsStore((s) => s.settings.terminalScrollback);
  const resolvedFont = fontFamily || settingsFont || "monospace";
  const resolvedSize = fontSize || settingsFontSize || 14;
  const resolvedScrollback = Math.max(100, scrollback || 5000);

  // ── Ctrl+F via global router (does not fight the editor) ───────────
  useEffect(() => {
    if (!active) {
      registerTerminalFind(null);
      return;
    }
    registerTerminalFind(() => {
      setSearchOpen(true);
      requestAnimationFrame(() => {
        const input = searchInputRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      });
    });
    return () => registerTerminalFind(null);
  }, [active]);

  // Close search when the terminal tab loses focus.
  useEffect(() => {
    if (!active) setSearchOpen(false);
  }, [active]);

  // When search opens, focus the input (and select text if any).
  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      if (input.value) input.select();
    });
  }, [searchOpen]);

  // SearchAddon requires solid #RRGGBB (no alpha).
  // Light: soft blue matches + stronger blue current.
  // Dark: muted amber matches + brighter amber current.
  const isLight = appTheme === "light";
  const searchDecorations = isLight
    ? {
        matchBackground: "#dbeafe",
        matchBorder: "#93c5fd",
        activeMatchBackground: "#60a5fa",
        matchOverviewRuler: "#93c5fd",
        activeMatchColorOverviewRuler: "#2563eb",
      }
    : {
        matchBackground: "#3f3f46",
        matchBorder: "#71717a",
        activeMatchBackground: "#a16207",
        matchOverviewRuler: "#71717a",
        activeMatchColorOverviewRuler: "#eab308",
      };

  // Keep latest decorations for find helpers without re-binding listeners.
  const searchDecorationsRef = useRef(searchDecorations);
  searchDecorationsRef.current = searchDecorations;
  const searchTextRef = useRef(searchText);
  searchTextRef.current = searchText;

  const findNext = (text?: string) => {
    const q = (text ?? searchTextRef.current).trim();
    if (!q || !searchAddonRef.current) return;
    try {
      searchAddonRef.current.findNext(q, {
        decorations: searchDecorationsRef.current,
      });
    } catch (err) {
      console.error("[search] findNext failed", err);
    }
  };
  const findPrev = (text?: string) => {
    const q = (text ?? searchTextRef.current).trim();
    if (!q || !searchAddonRef.current) return;
    try {
      searchAddonRef.current.findPrevious(q, {
        decorations: searchDecorationsRef.current,
      });
    } catch (err) {
      console.error("[search] findPrevious failed", err);
    }
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchText("");
    try {
      searchAddonRef.current?.clearDecorations();
    } catch {
      /* empty */
    }
    termRef.current?.focus();
  };

  // ── Terminal session lifecycle ──────────────────────────────────────
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const theme = terminalThemeForChrome(
      useSettingsStore.getState().settings.theme,
    );
    const settings = useSettingsStore.getState().settings;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: resolvedFont,
      fontSize: resolvedSize,
      scrollback: Math.max(100, settings.terminalScrollback || 5000),
      theme,
      allowProposedApi: true,
      // right-click paste handled below; middle-click paste via xterm default where supported
      rightClickSelectsWord: false,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    searchAddonRef.current = searchAddon;
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    const doFit = () => {
      try {
        if (el.clientWidth < 20 || el.clientHeight < 20) return;
        fit.fit();
        // Always push size to PTY — remote shell reflows MOTD/prompt.
        const cols = term.cols;
        const rows = term.rows;
        if (cols > 0 && rows > 0) {
          terminalResize(tab.sessionId, tab.channelId, cols, rows).catch(
            () => {},
          );
        }
      } catch {
        /* empty */
      }
    };
    // Fit after layout: opening with editor split often measures 0 height first.
    doFit();
    requestAnimationFrame(() => {
      doFit();
      requestAnimationFrame(doFit);
    });
    const fitTimers = [50, 150, 400].map((ms) =>
      window.setTimeout(doFit, ms),
    );

    for (const b of replayTerminalHistory(tab.sessionId)) term.write(b);
    consumeTerminalOutput(tab.sessionId);

    const poll = setInterval(() => {
      for (const b of consumeTerminalOutput(tab.sessionId)) term.write(b);
    }, 80);

    const writeInput = (d: string) => {
      const enc = encodeTerminalInput(d);
      terminalWrite(tab.sessionId, tab.channelId, enc).catch(() => {});
      for (const t of useSessionsStore
        .getState()
        .getSyncedTargets(tab.sessionId)) {
        terminalWrite(t.sessionId, t.channelId, enc).catch(() => {});
      }
    };

    const unsub = term.onData((d) => writeInput(d));

    // Select-to-copy (optional).
    const selDisp = term.onSelectionChange(() => {
      if (!useSettingsStore.getState().settings.copyOnSelect) return;
      const sel = term.getSelection();
      if (!sel) return;
      void navigator.clipboard.writeText(sel).catch(() => {});
    });

    // Clipboard shortcuts + block browser Ctrl+C when selection exists.
    const onKey = term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl+Shift+C → copy selection (also keep as explicit copy)
      if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel).catch(() => {});
        }
        return false;
      }
      // Ctrl+V → paste (also accept Ctrl+Shift+V)
      if (
        mod &&
        (e.key === "v" || e.key === "V") &&
        (!e.altKey)
      ) {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) writeInput(text);
          })
          .catch(() => {});
        return false;
      }
      // Plain Ctrl+C: if there is a selection, copy instead of sending ^C
      // (user can click to clear selection then Ctrl+C to interrupt).
      if (mod && !e.shiftKey && (e.key === "c" || e.key === "C")) {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel).catch(() => {});
          term.clearSelection();
          return false;
        }
      }
      return true;
    });

    // Right-click paste (common in SSH clients).
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) writeInput(text);
        })
        .catch(() => {});
    };
    el.addEventListener("contextmenu", onContextMenu);

    // Middle-click paste (Linux-style / many terminals).
    const onAuxClick = (ev: MouseEvent) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) writeInput(text);
        })
        .catch(() => {});
    };
    el.addEventListener("auxclick", onAuxClick);

    const resizeUnsub = term.onResize(({ cols, rows }) => {
      if (cols > 0 && rows > 0) {
        terminalResize(tab.sessionId, tab.channelId, cols, rows).catch(
          () => {},
        );
      }
    });
    // Initial PTY size after first fit attempt
    doFit();
    if (active) term.focus();

    const ro = new ResizeObserver(() => doFit());
    ro.observe(el);

    return () => {
      for (const t of fitTimers) window.clearTimeout(t);
      ro.disconnect();
      clearInterval(poll);
      unsub.dispose();
      selDisp.dispose();
      resizeUnsub.dispose();
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("auxclick", onAuxClick);
      void onKey;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.sessionId, tab.channelId]);

  // ── Live-update theme / font / scrollback preference ────────────────
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalThemeForChrome(appTheme);
    term.options.fontFamily = resolvedFont;
    term.options.fontSize = resolvedSize;
    // scrollback is applied on next session open (xterm limitation for live change)
    try {
      if (fitRef.current && elRef.current) {
        const el = elRef.current;
        if (el.clientWidth > 0 && el.clientHeight > 0) fitRef.current.fit();
      }
    } catch {
      /* empty */
    }
  }, [appTheme, resolvedFont, resolvedSize, resolvedScrollback, copyOnSelect]);

  useEffect(() => {
    if (!searchOpen) {
      requestAnimationFrame(() => {
        try {
          const el = elRef.current;
          if (active && el && el.clientWidth >= 20 && el.clientHeight >= 20) {
            fitRef.current?.fit();
          }
          if (active) termRef.current?.focus();
        } catch {
          /* empty */
        }
      });
    }
  }, [active, searchOpen]);

  // Re-fit when the pane is resized by CSS flex (editor open/close, window resize).
  // ResizeObserver on the terminal root catches height changes that child el alone might miss.
  useEffect(() => {
    const root = elRef.current?.parentElement;
    if (!root) return;
    const ro = new ResizeObserver(() => {
      try {
        const el = elRef.current;
        if (!el || el.clientWidth < 20 || el.clientHeight < 20) return;
        fitRef.current?.fit();
      } catch {
        /* empty */
      }
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [tab.sessionId, tab.channelId]);

  return (
    <div
      className="relative h-full w-full min-h-0 overflow-hidden px-2.5 py-1.5"
      data-terminal-root
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        position: active ? "relative" : "absolute",
        inset: active ? undefined : 0,
        zIndex: active ? 1 : 0,
      }}
    >
      <div
        ref={elRef}
        className="absolute inset-2.5 bottom-1.5 top-1.5 min-h-0 min-w-0 overflow-hidden [&_.xterm]:h-full [&_.xterm-viewport]:overflow-auto"
      />

      {/* Search overlay — top of terminal pane only */}
      {active && searchOpen && (
        <div
          className="absolute inset-x-0 top-0 z-[200] flex justify-center pt-2 pointer-events-none"
          role="dialog"
          aria-label="终端搜索"
          data-terminal-search
        >
          <div className="pointer-events-auto flex w-[min(420px,calc(100%-2rem))] items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 shadow-2xl ring-1 ring-black/20">
            <input
              ref={searchInputRef}
              data-terminal-search-input
              className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
              placeholder="在终端中查找…"
              autoFocus
              value={searchText}
              onChange={(e) => {
                const v = e.target.value;
                setSearchText(v);
                findNext(v);
              }}
              onKeyDown={(e) => {
                // Don't let xterm / document handlers see these keys.
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeSearch();
                  return;
                }
                // Tab / Enter → next match; Shift+Tab / Shift+Enter → previous
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  e.shiftKey ? findPrev() : findNext();
                  return;
                }
                // F3 / Shift+F3 (common IDE find shortcuts)
                if (e.key === "F3") {
                  e.preventDefault();
                  e.shiftKey ? findPrev() : findNext();
                }
              }}
            />
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="上一个 (Shift+Tab / Shift+Enter)"
              onMouseDown={(e) => {
                // Keep focus in the input so typing continues after click.
                e.preventDefault();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                findPrev();
                searchInputRef.current?.focus();
              }}
            >
              ↑
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="下一个 (Tab / Enter)"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                findNext();
                searchInputRef.current?.focus();
              }}
            >
              ↓
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Cleanup helper for closing a session tab. */
export function disposeTerminalSession(sessionId: string) {
  clearTerminalBuffers(sessionId);
}
