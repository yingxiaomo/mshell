import { useCallback, useRef, type FC } from "react";
import type { SideViewId } from "../../types/protocol";
import { useUiStore } from "../../stores/ui";
import { SessionList } from "../sessions/SessionList";
import { FilesView } from "../files/FilesView";
import { TunnelsView } from "../tunnels/TunnelsView";
import { SettingsView } from "../settings/SettingsView";

const VIEWS: Record<SideViewId, FC> = {
  sessions: SessionList,
  files: FilesView,
  tunnels: TunnelsView,
  settings: SettingsView,
};

export function SidePanel() {
  const activeView = useUiStore((s) => s.activeView);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const View = VIEWS[activeView];
  const dragging = useRef(false);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const next = Math.min(480, Math.max(180, startW + (ev.clientX - startX)));
        setSidebarWidth(next);
      };
      const onUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
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
        <View />
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
