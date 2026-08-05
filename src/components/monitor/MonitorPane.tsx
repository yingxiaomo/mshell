import { X } from "lucide-react";
import { useUiStore } from "../../stores/ui";
import { useSessionsStore } from "../../stores/sessions";
import { MonitorView } from "./MonitorView";

/** Right-side monitor panel for the Shell layout. */
export function MonitorPane() {
  const tabs = useSessionsStore((s) => s.tabs);
  const setShowMonitor = useUiStore((s) => s.setShowMonitor);

  if (tabs.length === 0) return null;

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-medium text-zinc-400">服务器监控</span>
        <button
          type="button"
          className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="关闭监控"
          onClick={() => setShowMonitor(false)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MonitorView />
      </div>
    </aside>
  );
}
