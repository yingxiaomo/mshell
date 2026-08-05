import { clsx } from "clsx";
import type { SideViewId } from "../../types/protocol";
import { useUiStore } from "../../stores/ui";
import { ShortcutHelp } from "../ui/ShortcutHelp";
import { getFeatures, getPinnedFeatures } from "../../features/registry";

export function ActivityBar() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);

  return (
    <nav
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-950 py-2"
      aria-label="活动栏"
    >
      {/* 特性图标（顶部区域） */}
      {getFeatures().map(({ id, icon: Icon, label }) => {
        const active = activeView === id;
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            onClick={() => setActiveView(id as SideViewId)}
            className={clsx(
              "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors",
              active
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
            )}
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-sky-500" aria-hidden />
            )}
            <Icon className="h-5 w-5" strokeWidth={1.75} />
          </button>
        );
      })}

      {/* 底部区域：快捷操作 */}
      <div className="mt-auto flex flex-col items-center gap-1 pb-1">
        <ShortcutHelp />
        {getPinnedFeatures().map(({ id, icon: Icon, label }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => setActiveView(id as SideViewId)}
              className={clsx(
                "relative flex h-10 w-10 items-center justify-center rounded-md transition-colors",
                active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-sky-500" aria-hidden />
              )}
              <Icon className="h-5 w-5" strokeWidth={1.75} />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
