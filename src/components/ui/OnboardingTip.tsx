import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useConnectionsStore } from "../../stores/connections";
import { useUiStore } from "../../stores/ui";

const STORAGE_KEY = "momoshell.onboarding.dismissed.v1";

/**
 * One-time welcome tip when the user has no connections yet.
 * Stored in localStorage so it only shows until dismissed (or first connection).
 */
export function OnboardingTip() {
  const items = useConnectionsStore((s) => s.items);
  const loading = useConnectionsStore((s) => s.loading);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);

  const [visible, setVisible] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Wait until connections have been loaded at least once (loading goes true→false).
  useEffect(() => {
    if (loading) setBootstrapped(true);
  }, [loading]);

  useEffect(() => {
    if (!bootstrapped || loading) return;
    if (items.length > 0) {
      setVisible(false);
      return;
    }
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") {
        setVisible(false);
        return;
      }
    } catch {
      /* ignore */
    }
    setVisible(true);
  }, [bootstrapped, loading, items.length]);

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-12 z-[40] flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-lg border border-sky-700/40 bg-zinc-900 px-4 py-3 shadow-xl ring-1 ring-sky-500/20">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-100">欢迎使用 momoshell</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            在左侧「连接」里新建 SSH / Telnet / 本地终端。之后可用{" "}
            <kbd className="rounded border border-zinc-700 px-1 text-[10px]">
              Ctrl+P
            </kbd>{" "}
            快速打开连接，
            <kbd className="rounded border border-zinc-700 px-1 text-[10px]">
              ?
            </kbd>{" "}
            查看全部快捷键。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500"
              onClick={() => {
                setActiveView("sessions");
                dismiss();
              }}
            >
              去添加连接
            </button>
            <button
              type="button"
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              onClick={() => {
                setCommandPaletteOpen(true);
                dismiss();
              }}
            >
              打开命令面板
            </button>
            <button
              type="button"
              className="rounded-md px-2.5 py-1 text-xs text-zinc-500 hover:text-zinc-300"
              onClick={dismiss}
            >
              知道了
            </button>
          </div>
        </div>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          title="关闭"
          onClick={dismiss}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
