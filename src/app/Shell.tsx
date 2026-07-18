import { useCallback, useRef } from "react";
import { ActivityBar } from "../components/layout/ActivityBar";
import { SidePanel } from "../components/layout/SidePanel";
import { TitleBar } from "../components/layout/TitleBar";
import { TransferBar } from "../components/layout/TransferBar";
import { TerminalTabs } from "../components/terminal/TerminalTabs";
import { FileEditor } from "../components/editor/FileEditor";
import { useUiStore } from "../stores/ui";

export function Shell() {
  const editorFile = useUiStore((s) => s.editorFile);
  const closeEditor = useUiStore((s) => s.closeEditor);
  const splitRatio = useUiStore((s) => s.editorSplitRatio);
  const setSplitRatio = useUiStore((s) => s.setEditorSplitRatio);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = splitRatio;
      const container = containerRef.current;
      if (!container) return;
      const onMove = (ev: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const newRatio = Math.max(0.2, Math.min(0.85, startRatio + (ev.clientY - startY) / rect.height));
        setSplitRatio(newRatio);
      };
      const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [splitRatio, setSplitRatio],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <SidePanel />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-950">
          {/* Editor pane — rendered only when a file is open */}
          {editorFile && (
            <div ref={containerRef} className="flex min-h-0 flex-col overflow-hidden" style={{ flex: splitRatio }}>
              <FileEditor
                sessionId={editorFile.sessionId}
                remotePath={editorFile.remotePath}
                filename={editorFile.name}
                onClose={closeEditor}
              />
            </div>
          )}

          {/* Drag handle — only when split */}
          {editorFile && (
            <div
              className="group relative flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-zinc-900 hover:bg-zinc-800"
              onMouseDown={onDrag}
            >
              <div className="h-0.5 w-8 rounded-full bg-zinc-700 group-hover:bg-zinc-500" />
            </div>
          )}

          {/* Terminal — ALWAYS rendered, never unmounted */}
          <div className="flex min-h-0 flex-col overflow-hidden" style={{ flex: editorFile ? 1 - splitRatio : 1 }}>
            <TerminalTabs />
          </div>
        </main>
      </div>
      <TransferBar />
    </div>
  );
}
