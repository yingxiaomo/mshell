import type { FC } from "react";
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
  const View = VIEWS[activeView];

  return (
    <aside
      className="flex h-full shrink-0 flex-col overflow-hidden border-r border-zinc-800 bg-zinc-900/40"
      style={{ width: sidebarWidth }}
      aria-label="侧栏"
    >
      <View />
    </aside>
  );
}
