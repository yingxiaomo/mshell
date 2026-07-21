import { useCallback, useEffect, useRef } from "react";
import { ActivityBar } from "../components/layout/ActivityBar";
import { SidePanel } from "../components/layout/SidePanel";
import { TitleBar } from "../components/layout/TitleBar";
import { TransferBar } from "../components/layout/TransferBar";
import { ToastContainer } from "../components/ui/Toast";
import { OnboardingTip } from "../components/ui/OnboardingTip";
import {
  SessionTabBar,
  TerminalPane,
} from "../components/terminal/TerminalTabs";
import { EditorTabs } from "../components/editor/EditorTabs";
import { CommandPalette } from "../components/command/CommandPalette";
import { useUiStore } from "../stores/ui";
import { useSessionsStore } from "../stores/sessions";

export function Shell() {
  const editorTabs = useUiStore((s) => s.editorTabs);
  const closeEditorForSession = useUiStore((s) => s.closeEditorForSession);
  const splitRatio = useUiStore((s) => s.editorSplitRatio);
  const setSplitRatio = useUiStore((s) => s.setEditorSplitRatio);
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Only show the editor pane for files belonging to the active session.
  const hasEditors = editorTabs.some(
    (t) => t.sessionId === activeSessionId,
  );

  // Drop editor tabs whose terminal session is gone.
  // Depend on tabs only — reading editorTabs inside avoids loops when we close.
  useEffect(() => {
    const openIds = new Set(tabs.map((t) => t.sessionId));
    const currentEditors = useUiStore.getState().editorTabs;
    const orphanSessions = new Set(
      currentEditors
        .map((e) => e.sessionId)
        .filter((id) => !openIds.has(id)),
    );
    for (const sid of orphanSessions) {
      closeEditorForSession(sid);
    }
  }, [tabs, closeEditorForSession]);

  const onDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startRatio = splitRatio;
      const container = containerRef.current;
      if (!container) return;
      // Measure the whole main column so drag stays consistent with flex siblings.
      const main = container.parentElement;
      const onMove = (ev: MouseEvent) => {
        const rect = (main ?? container).getBoundingClientRect();
        // Account for session tab bar + handle: use main height.
        const newRatio = Math.max(
          0.2,
          Math.min(0.65, startRatio + (ev.clientY - startY) / rect.height),
        );
        setSplitRatio(newRatio);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
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
          {/*
            Layout (top → bottom):
              1. Session tabs  — always pinned at top
              2. Multi-file editor (optional)
              3. Drag handle
              4. Terminal body
          */}
          <SessionTabBar />

          {hasEditors && (
            <div
              ref={containerRef}
              className="flex min-h-0 flex-col overflow-hidden border-b border-zinc-800"
              style={{ flex: splitRatio }}
            >
              <EditorTabs />
            </div>
          )}

          {hasEditors && (
            <div
              className="group relative flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-zinc-900 hover:bg-zinc-800"
              onMouseDown={onDrag}
              title="拖动调整 编辑器 / 终端 高度"
            >
              <div className="h-0.5 w-8 rounded-full bg-zinc-700 group-hover:bg-zinc-500" />
            </div>
          )}

          <div
            className="flex min-h-[180px] min-w-0 flex-1 flex-col overflow-hidden"
            style={{ flex: hasEditors ? Math.max(0.35, 1 - splitRatio) : 1 }}
            data-terminal-host
          >
            <TerminalPane />
          </div>
        </main>
      </div>
      <TransferBar />
      <ToastContainer />
      <OnboardingTip />
      <CommandPalette />
    </div>
  );
}
