import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";

function tryCurrentWindow(): Window | null {
  try {
    // Throws when not running inside a Tauri webview (or before IPC is ready).
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = tryCurrentWindow();
    if (!win) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void win
      .isMaximized()
      .then((v) => {
        if (!cancelled) setMaximized(v);
      })
      .catch(() => {});

    void win
      .onResized(() => {
        void win
          .isMaximized()
          .then((v) => {
            if (!cancelled) setMaximized(v);
          })
          .catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const onDrag = useCallback((e: MouseEvent) => {
    if (e.buttons !== 1) return;
    const win = tryCurrentWindow();
    void win?.startDragging().catch(() => {});
  }, []);

  const onDoubleClick = useCallback(() => {
    const win = tryCurrentWindow();
    void win?.toggleMaximize().catch(() => {});
  }, []);

  const minimize = useCallback(() => {
    const win = tryCurrentWindow();
    void win?.minimize().catch(() => {});
  }, []);

  const toggleMaximize = useCallback(() => {
    const win = tryCurrentWindow();
    void win?.toggleMaximize().catch(() => {});
  }, []);

  const close = useCallback(() => {
    const win = tryCurrentWindow();
    void win?.close().catch(() => {});
  }, []);

  return (
    <header className="flex h-9 shrink-0 select-none items-center border-b border-zinc-800 bg-zinc-950 text-zinc-100">
      <div
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-3"
        onMouseDown={onDrag}
        onDoubleClick={onDoubleClick}
        data-tauri-drag-region
      >
        <span className="text-xs font-semibold tracking-wide text-zinc-300">
          mshell
        </span>
        <span className="text-[10px] text-zinc-600">SSH</span>
      </div>
      <div className="flex h-full shrink-0">
        <button
          type="button"
          aria-label="最小化"
          onClick={minimize}
          className="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={maximized ? "还原" : "最大化"}
          onClick={toggleMaximize}
          className="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {maximized ? (
            <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
              <Square className="absolute bottom-0 right-0 h-[11px] w-[11px]" strokeWidth={1.5} />
              <Square className="absolute left-0 top-0 h-[11px] w-[11px]" strokeWidth={1.5} />
            </span>
          ) : (
            <Square className="h-3.5 w-3.5" strokeWidth={1.5} />
          )}
        </button>
        <button
          type="button"
          aria-label="关闭"
          onClick={close}
          className="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
