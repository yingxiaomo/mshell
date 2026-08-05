import { useEffect, useRef } from "react";
import { ActivityBar } from "../components/layout/ActivityBar";
import { SidePanel } from "../components/layout/SidePanel";
import { TitleBar } from "../components/layout/TitleBar";
import { TransferBar } from "../components/layout/TransferBar";
import { ToastContainer } from "../components/ui/Toast";
import { OnboardingTip } from "../components/ui/OnboardingTip";
import { ResizableSplitter } from "../components/ui/ResizableSplitter";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import {
  SessionTabBar,
  TerminalPane,
} from "../components/terminal/TerminalTabs";
import { EditorTabs } from "../components/editor/EditorTabs";
import { MonitorPane } from "../components/monitor/MonitorPane";
import { CommandPalette } from "../components/command/CommandPalette";
import { useUiStore } from "../stores/ui";
import { useSessionsStore } from "../stores/sessions";

export function Shell() {
  const editorTabs = useUiStore((s) => s.editorTabs);
  const closeEditorForSession = useUiStore((s) => s.closeEditorForSession);
  const showMonitor = useUiStore((s) => s.showMonitor);
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <ErrorBoundary><SidePanel /></ErrorBoundary>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-950">
          {/*
            Layout (top → bottom):
              1. Session tabs  — always pinned at top
              2. Multi-file editor (optional)
              3. Drag handle (via ResizableSplitter)
              4. Terminal body
          */}
          <SessionTabBar />

          {hasEditors && (
            <ResizableSplitter
              ratio={splitRatio}
              onRatioChange={setSplitRatio}
              containerRef={containerRef}
              minRatio={0.2}
              maxRatio={0.65}
            >
              <div
                ref={containerRef}
                className="flex min-h-0 flex-col overflow-hidden border-b border-zinc-800"
                style={{ flex: splitRatio }}
              >
                <EditorTabs />
              </div>
            </ResizableSplitter>
          )}

          <div
            className="flex min-h-[180px] min-w-0 flex-1 flex-col overflow-hidden"
            style={{ flex: hasEditors ? Math.max(0.35, 1 - splitRatio) : 1 }}
            data-terminal-host
          >
            <TerminalPane />
          </div>
        </main>

        {/* Right-side monitor panel */}
        {showMonitor && tabs.length > 0 && (
          <MonitorPane />
        )}
      </div>
      <TransferBar />
      <ToastContainer />
      <OnboardingTip />
      <CommandPalette />
    </div>
  );
}
