import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  decodeTerminalOutputBytes,
  encodeTerminalInput,
  onTerminalOutput,
} from "../../lib/events";
import { terminalResize, terminalWrite } from "../../lib/tauri";
import type { TerminalTab } from "../../stores/sessions";

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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
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
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.focus();

    termRef.current = term;
    fitRef.current = fit;

    const onDataDisp = term.onData((data) => {
      void terminalWrite(
        tab.sessionId,
        tab.channelId,
        encodeTerminalInput(data),
      ).catch(() => {
        /* channel may be closing */
      });
    });

    const onResizeDisp = term.onResize(({ cols, rows }) => {
      void terminalResize(tab.sessionId, tab.channelId, cols, rows).catch(
        () => {},
      );
    });

    // Initial size notify after fit.
    void terminalResize(
      tab.sessionId,
      tab.channelId,
      term.cols,
      term.rows,
    ).catch(() => {});

    let unlisten: (() => void) | undefined;
    void onTerminalOutput((ev) => {
      if (
        ev.sessionId !== tab.sessionId ||
        ev.channelId !== tab.channelId
      ) {
        return;
      }
      const bytes = decodeTerminalOutputBytes(ev.dataB64);
      term.write(bytes);
    }).then((fn) => {
      unlisten = fn;
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore if disposed */
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      unlisten?.();
      onDataDisp.dispose();
      onResizeDisp.dispose();
      term.dispose();
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
    <div
      className="h-full w-full min-h-0"
      style={{ display: active ? "block" : "none" }}
      ref={containerRef}
    />
  );
}
