import { useCallback, useEffect, useMemo } from "react";
import { X } from "lucide-react";
import { useUiStore } from "../../stores/ui";
import { useSessionsStore } from "../../stores/sessions";
import { FileEditor } from "./FileEditor";

/**
 * Multi-file editor strip scoped to the *active terminal session*.
 * Switching sessions only shows that session's open files (no cross-session inherit).
 */
export function EditorTabs() {
  const editorTabs = useUiStore((s) => s.editorTabs);
  const activeEditorId = useUiStore((s) => s.activeEditorId);
  const setActiveEditor = useUiStore((s) => s.setActiveEditor);
  const closeEditorTab = useUiStore((s) => s.closeEditorTab);
  const setEditorDirty = useUiStore((s) => s.setEditorDirty);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);

  const sessionTabs = useMemo(
    () =>
      activeSessionId
        ? editorTabs.filter((t) => t.sessionId === activeSessionId)
        : [],
    [editorTabs, activeSessionId],
  );

  // If active editor belongs to another session, focus a tab of this session.
  useEffect(() => {
    if (sessionTabs.length === 0) return;
    const activeInSession = sessionTabs.some((t) => t.id === activeEditorId);
    if (!activeInSession) {
      setActiveEditor(sessionTabs[sessionTabs.length - 1]!.id);
    }
  }, [sessionTabs, activeEditorId, setActiveEditor]);

  const makeDirtyHandler = useCallback(
    (id: string) => (dirty: boolean) => setEditorDirty(id, dirty),
    [setEditorDirty],
  );

  if (sessionTabs.length === 0) return null;

  const active =
    sessionTabs.find((t) => t.id === activeEditorId) ??
    sessionTabs[sessionTabs.length - 1]!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-800 bg-zinc-900/60 px-1">
        {sessionTabs.map((tab) => {
          const isActive = tab.id === active.id;
          return (
            <div
              key={tab.id}
              className={
                isActive
                  ? "group flex max-w-[200px] items-center gap-1 border-b-2 border-sky-500 bg-zinc-800/80 px-2 py-1 text-xs text-zinc-100"
                  : "group flex max-w-[200px] items-center gap-1 border-b-2 border-transparent px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
              }
            >
              <button
                type="button"
                className="min-w-0 truncate"
                title={tab.remotePath}
                onClick={() => setActiveEditor(tab.id)}
              >
                {tab.dirty ? (
                  <span className="mr-1 text-sky-400" aria-label="未保存">
                    ●
                  </span>
                ) : null}
                {tab.name}
              </button>
              <button
                type="button"
                className="rounded p-0.5 text-zinc-500 opacity-70 hover:bg-zinc-700 hover:text-zinc-200 group-hover:opacity-100"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  closeEditorTab(tab.id);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="relative min-h-0 flex-1">
        {sessionTabs.map((tab) => (
          <EditorTabPane
            key={tab.id}
            sessionId={tab.sessionId}
            remotePath={tab.remotePath}
            name={tab.name}
            active={tab.id === active.id}
            onClose={() => closeEditorTab(tab.id)}
            onDirtyChange={makeDirtyHandler(tab.id)}
          />
        ))}
      </div>
    </div>
  );
}

function EditorTabPane({
  sessionId,
  remotePath,
  name,
  active,
  onClose,
  onDirtyChange,
}: {
  sessionId: string;
  remotePath: string;
  name: string;
  active: boolean;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  return (
    <div
      className="absolute inset-0"
      style={{
        visibility: active ? "visible" : "hidden",
        pointerEvents: active ? "auto" : "none",
        zIndex: active ? 1 : 0,
      }}
    >
      <FileEditor
        sessionId={sessionId}
        remotePath={remotePath}
        filename={name}
        onClose={onClose}
        onDirtyChange={onDirtyChange}
        compactHeader
        active={active}
      />
    </div>
  );
}
