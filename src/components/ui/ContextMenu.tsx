import { useEffect, useRef } from "react";
import { clsx } from "clsx";

export type ContextMenuItem =
  | {
      kind: "item";
      id: string;
      label: string;
      danger?: boolean;
      disabled?: boolean;
    }
  | { kind: "sep"; id: string };

export type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
};

type Props = {
  menu: ContextMenuState | null;
  onClose: () => void;
  onSelect: (id: string) => void;
};

/**
 * Lightweight fixed-position context menu.
 * Closes on outside click / Escape.
 */
export function ContextMenu({ menu, onClose, onSelect }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Defer so the opening contextmenu event doesn't immediately close us.
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // Keep menu on-screen.
  const maxW = 220;
  const estH = menu.items.length * 28 + 8;
  const left = Math.min(menu.x, window.innerWidth - maxW - 8);
  const top = Math.min(menu.y, window.innerHeight - estH - 8);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-[180px] max-w-[240px] rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
      style={{ left, top }}
    >
      {menu.items.map((it) => {
        if (it.kind === "sep") {
          return (
            <div
              key={it.id}
              className="my-1 border-t border-zinc-800"
              role="separator"
            />
          );
        }
        return (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            className={clsx(
              "flex w-full items-center px-3 py-1.5 text-left text-xs",
              it.disabled
                ? "cursor-not-allowed text-zinc-600"
                : it.danger
                  ? "text-red-400 hover:bg-zinc-800"
                  : "text-zinc-200 hover:bg-zinc-800",
            )}
            onClick={() => {
              if (it.disabled) return;
              onSelect(it.id);
              onClose();
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
