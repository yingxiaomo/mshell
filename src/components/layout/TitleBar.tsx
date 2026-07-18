import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    void win.isMaximized().then(setMaximized).catch(() => {});

    void win
      .onResized(() => {
        void win.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      unlisten?.();
    };
  }, []);

  const onDrag = useCallback((e: MouseEvent) => {
    if (e.buttons !== 1) return;
    void getCurrentWindow().startDragging().catch(() => {});
  }, []);

  const onDoubleClick = useCallback(() => {
    void getCurrentWindow().toggleMaximize().catch(() => {});
  }, []);

  const minimize = useCallback(() => {
    void getCurrentWindow().minimize().catch(() => {});
  }, []);

  const toggleMaximize = useCallback(() => {
    void getCurrentWindow().toggleMaximize().catch(() => {});
  }, []);

  const close = useCallback(() => {
    void getCurrentWindow().close().catch(() => {});
  }, []);

  return (
    <header className="flex h-9 shrink-0 select-none items-center border-b border-zinc-800 bg-zinc-950">
      <div
        className="flex h-full min-w-0 flex-1 items-center px-3"
        onMouseDown={onDrag}
        onDoubleClick={onDoubleClick}
        data-tauri-drag-region
      >
        <span className="text-xs font-medium tracking-wide text-zinc-400">
          momoshell
        </span>
      </div>
      <div className="flex h-full shrink-0">
        <button
          type="button"
          aria-label="最小化"
          onClick={minimize}
          className="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label={maximized ? "还原" : "最大化"}
          onClick={toggleMaximize}
          className="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {maximized ? (
            <Copy className="h-3 w-3 -scale-x-100" strokeWidth={2} />
          ) : (
            <Square className="h-3 w-3" strokeWidth={2} />
          )}
        </button>
        <button
          type="button"
          aria-label="关闭"
          onClick={close}
          className="flex h-full w-11 items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}
