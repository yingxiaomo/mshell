import { useCallback, useEffect, useRef } from "react";
import { useUiStore } from "../../stores/ui";
import { useSessionsStore } from "../../stores/sessions";
import { getFeature } from "../../features/registry";
import { SessionNotes } from "../sessions/SessionNotes";

export function SidePanel() {
  const activeView = useUiStore((s) => s.activeView);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const dragging = useRef(false);
  const dragAbortRef = useRef<AbortController | null>(null);
  // Abort an in-progress resize drag on unmount so the document listeners
  // don't leak past the component's lifetime.
  useEffect(() => () => dragAbortRef.current?.abort(), []);

  const tabs = useSessionsStore((s) => s.tabs);

  // 从注册表中获取当前视图的组件
  const feature = getFeature(activeView);
  const View = feature?.panel;

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startW = sidebarWidth;
      dragAbortRef.current?.abort();
      const controller = new AbortController();
      dragAbortRef.current = controller;
      const { signal } = controller;
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const next = Math.min(480, Math.max(180, startW + (ev.clientX - startX)));
        setSidebarWidth(next);
      };
      const onUp = () => {
        dragging.current = false;
        controller.abort();
      };
      document.addEventListener("mousemove", onMove, { signal });
      document.addEventListener("mouseup", onUp, { signal });
    },
    [sidebarWidth, setSidebarWidth],
  );

  return (
    <div className="relative flex h-full shrink-0">
      <aside
        className="flex h-full flex-col overflow-hidden border-r border-zinc-800 bg-zinc-900/40"
        style={{ width: sidebarWidth }}
        aria-label="侧栏"
      >
        {View ? <View /> : null}
        {activeView === "sessions" && tabs.length > 0 && <SessionNotes />}
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        title="拖动调整侧栏宽度"
        className="group absolute right-0 top-0 z-10 h-full w-1.5 translate-x-1/2 cursor-col-resize"
        onMouseDown={onResizeStart}
      >
        <div className="mx-auto h-full w-px bg-transparent group-hover:bg-sky-600/60" />
      </div>
    </div>
  );
}
