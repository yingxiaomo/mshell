import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { consumeTerminalOutput } from "../../lib/events";
import { terminalWrite, terminalResize } from "../../lib/tauri";
import { encodeTerminalInput } from "../../lib/events";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { themeByKey } from "../../lib/themes";
import type { TerminalTab } from "../../stores/sessions";

export type TerminalViewProps = {
  tab: TerminalTab;
  fontFamily?: string;
  fontSize?: number;
  active: boolean;
};

export function TerminalView({
  tab, fontFamily = "monospace", fontSize = 14, active,
}: TerminalViewProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState("");

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const themeKey = useSettingsStore.getState().settings.codeTheme;
    const theme = themeByKey(themeKey).terminal;
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontFamily, fontSize, theme });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    searchRef.current = searchAddon;
    term.open(el);
    try { fit.fit(); } catch {}

    termRef.current = term;
    fitRef.current = fit;

    // Poll shared buffer every 80ms for this session's output
    const poll = setInterval(() => {
      for (const b of consumeTerminalOutput(tab.sessionId)) term.write(b);
    }, 80);

    // Ctrl+F search
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") { setSearchVisible((v) => !v); return false; }
      return true;
    });

    const unsub = term.onData((d) => {
      const enc = encodeTerminalInput(d);
      terminalWrite(tab.sessionId, tab.channelId, enc).catch(() => {});
      for (const t of useSessionsStore.getState().getSyncedTargets(tab.sessionId)) {
        terminalWrite(t.sessionId, t.channelId, enc).catch(() => {});
      }
    });

    const resizeUnsub = term.onResize(({ cols, rows }) => {
      terminalResize(tab.sessionId, tab.channelId, cols, rows).catch(() => {});
    });
    terminalResize(tab.sessionId, tab.channelId, Math.max(term.cols, 80), Math.max(term.rows, 24)).catch(() => {});
    if (active) term.focus();

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
    ro.observe(el);

    return () => {
      ro.disconnect(); clearInterval(poll); unsub.dispose(); resizeUnsub.dispose();
      term.dispose(); termRef.current = null; fitRef.current = null; searchRef.current = null;
    };
  }, [tab.sessionId, tab.channelId]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try { fitRef.current?.fit(); termRef.current?.focus(); } catch { }
      });
    }
  }, [active]);

  return (
    <div className="relative h-full w-full min-h-0">
      <div ref={elRef} className="h-full w-full min-h-0" style={{ display: active ? "block" : "none" }} />
      {active && searchVisible && (
        <div className="absolute left-2 right-2 top-2 z-10 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 shadow-lg">
          <input className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs text-zinc-100 outline-none" placeholder="搜索终端..." autoFocus value={searchText}
            onChange={(e) => { setSearchText(e.target.value); searchRef.current?.findNext(e.target.value); }}
            onKeyDown={(e) => { if (e.key === "Escape") setSearchVisible(false); }} />
          <button type="button" className="rounded px-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={() => setSearchVisible(false)}>X</button>
        </div>
      )}
    </div>
  );
}
