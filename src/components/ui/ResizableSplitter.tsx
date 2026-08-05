import { useCallback, useEffect, useRef, type ReactNode } from "react";

type ResizableSplitterProps = {
  /** Current ratio (0–1). */
  ratio: number;
  /** Called when the user drags the handle. */
  onRatioChange: (r: number) => void;
  /** Container whose bounding rect is used to convert mouse delta → ratio delta. Falls back to the handle's parent. */
  containerRef?: React.RefObject<HTMLDivElement | null>;
  /** Minimum ratio (default 0.2). */
  minRatio?: number;
  /** Maximum ratio (default 0.65). */
  maxRatio?: number;
  /** Content rendered above the handle. */
  children?: ReactNode;
};

/**
 * A resizable splitter with a draggable handle. Designed for vertical splits
 * (editor on top, terminal on bottom). Uses document-level mouse events so the
 * drag isn't clipped by sibling overflow. Aborts on unmount.
 */
export function ResizableSplitter({
  ratio,
  onRatioChange,
  containerRef,
  minRatio = 0.2,
  maxRatio = 0.65,
  children,
}: ResizableSplitterProps) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragAbortRef = useRef<AbortController | null>(null);

  // Abort any in-progress drag if the component unmounts mid-drag
  useEffect(() => () => dragAbortRef.current?.abort(), []);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = ratio;

      const container = containerRef?.current ?? handleRef.current?.parentElement;
      const main = container?.parentElement;

      dragAbortRef.current?.abort();
      const controller = new AbortController();
      dragAbortRef.current = controller;
      const { signal } = controller;

      const onMove = (ev: MouseEvent) => {
        const rect = (main ?? container)!.getBoundingClientRect();
        const delta = (ev.clientY - startY) / rect.height;
        const clamped = Math.max(minRatio, Math.min(maxRatio, startRatio + delta));
        if (clamped !== ratio) {
          onRatioChange(clamped);
        }
      };

      const onUp = () => {
        controller.abort();
      };

      document.addEventListener("mousemove", onMove, { signal });
      document.addEventListener("mouseup", onUp, { signal });
    },
    [ratio, onRatioChange, containerRef, minRatio, maxRatio],
  );

  return (
    <>
      {children}

      <div
        ref={handleRef}
        className="group relative flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-zinc-900 hover:bg-zinc-800"
        onMouseDown={onDragStart}
        title="拖动调整高度"
      >
        <div className="h-0.5 w-8 rounded-full bg-zinc-700 group-hover:bg-zinc-500" />
      </div>
    </>
  );
}
