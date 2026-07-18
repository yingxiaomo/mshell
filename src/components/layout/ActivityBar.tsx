import { Folder, Network, Server, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { clsx } from "clsx";
import type { SideViewId } from "../../types/protocol";
import { useUiStore } from "../../stores/ui";
import { ShortcutHelp } from "../ui/ShortcutHelp";

const ITEMS: { id: SideViewId; label: string; Icon: LucideIcon }[] = [
  { id: "sessions", label: "连接", Icon: Server },
  { id: "files", label: "文件", Icon: Folder },
  { id: "tunnels", label: "隧道", Icon: Network },
  { id: "settings", label: "设置", Icon: Settings },
];

export function ActivityBar() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);

  return (
    <nav
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-950 py-2"
      aria-label="活动栏"
    >
      {ITEMS.map(({ id, label, Icon }) => {
        const active = activeView === id;
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={() => setActiveView(id)}
            className={clsx(
              "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors",
              active
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
            )}
          >
            {active && (
              <span
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-sky-500"
                aria-hidden
              />
            )}
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </button>
        );
      })}
      <div className="mt-auto flex flex-col items-center gap-1 pb-1">
        <ShortcutHelp />
      </div>
    </nav>
  );
}
