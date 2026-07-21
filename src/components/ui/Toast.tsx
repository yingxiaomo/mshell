import { useEffect, useRef, useState } from "react";

export type ToastKind = "info" | "success" | "error";

export type ToastMessage = {
  id: string;
  kind: ToastKind;
  text: string;
  /** Auto-dismiss duration in ms; <= 0 means sticky. */
  duration: number;
  createdAt: number;
};

type ToastState = {
  items: ToastMessage[];
  toast: (text: string, kind?: ToastKind, duration?: number) => void;
  dismiss: (id: string) => void;
};

const TOAST_KEY = "__momoshell_toast_store_v1__";
type GlobalBag = typeof globalThis & {
  [TOAST_KEY]?: ToastState;
};

let g = globalThis as GlobalBag;
let state: ToastState = g[TOAST_KEY]!;
if (!state) {
  const listeners = new Set<() => void>();
  let items: ToastMessage[] = [];
  let idCounter = 1;

  const notify = () => {
    for (const fn of listeners) fn();
  };

  state = {
    items,
    toast: (text, kind = "info", duration = 4000) => {
      const msg: ToastMessage = {
        id: `toast-${++idCounter}`,
        kind,
        text,
        duration,
        createdAt: Date.now(),
      };
      items = [...items, msg];
      notify();
      if (duration > 0) {
        setTimeout(() => {
          items = items.filter((t) => t.id !== msg.id);
          notify();
        }, duration);
      }
    },
    dismiss: (id: string) => {
      items = items.filter((t) => t.id !== id);
      notify();
    },
  };

  // Expose as reactive store by notifying subscribers on change.
  state.items = items;
  g[TOAST_KEY] = state;
}

function getState(): ToastState {
  return g[TOAST_KEY]!;
}

export function useToast() {
  const [, setTick] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    const items = getState();
    // Subscribe to changes
    const og = items.items;

    // Poll-based subscription (simplest HMR-safe approach)
    let prevLen = og.length;
    const iv = setInterval(() => {
      const cur = getState().items.length;
      if (cur !== prevLen || (cur > 0 && getState().items[0]?.text !== items.items[0]?.text)) {
        prevLen = cur;
        if (mounted.current) setTick((n) => n + 1);
      }
    }, 200);
    return () => {
      mounted.current = false;
      clearInterval(iv);
    };
  }, []);

  return {
    items: getState().items,
    toast: getState().toast,
    dismiss: getState().dismiss,
  };
}

export function showToast(text: string, kind?: ToastKind, duration?: number) {
  getState().toast(text, kind, duration);
}

export function ToastContainer() {
  const { items, dismiss } = useToast();

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-10 left-1/2 z-[999] flex -translate-x-1/2 flex-col items-center gap-1.5">
      {items.map((msg) => {
        const bg =
          msg.kind === "error"
            ? "bg-red-600/90"
            : msg.kind === "success"
              ? "bg-emerald-600/90"
              : "bg-zinc-800/95";
        return (
          <div
            key={msg.id}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-white shadow-lg ${bg}`}
            role="alert"
          >
            <span className="min-w-0 flex-1">{msg.text}</span>
            <button
              type="button"
              className="shrink-0 text-white/70 hover:text-white"
              onClick={() => dismiss(msg.id)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
