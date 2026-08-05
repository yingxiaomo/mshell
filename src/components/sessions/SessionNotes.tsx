import { useCallback, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { useUiStore } from "../../stores/ui";
import { useSessionsStore } from "../../stores/sessions";

/**
 * Session notes panel: markdown notes associated with the active session.
 * Auto-saves with 500ms debounce. Persisted to localStorage.
 */
export function SessionNotes() {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const tabs = useSessionsStore((s) => s.tabs);
  const sessionNotes = useUiStore((s) => s.sessionNotes);
  const setSessionNote = useUiStore((s) => s.setSessionNote);

  const activeTab = tabs.find((t) => t.sessionId === activeSessionId);
  const noteText = activeSessionId ? sessionNotes[activeSessionId] ?? "" : "";
  const [draft, setDraft] = useState(noteText);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 切换会话时重置草稿
  useEffect(() => {
    setDraft(activeSessionId ? sessionNotes[activeSessionId] ?? "" : "");
  }, [activeSessionId, sessionNotes]);

  // 防抖自动保存
  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (activeSessionId) setSessionNote(activeSessionId, value);
      }, 500);
    },
    [activeSessionId, setSessionNote],
  );

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!activeTab) return null;

  return (
    <div className="border-t border-zinc-800">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-3 py-1.5">
        <FileText className="h-3 w-3 text-zinc-500" />
        <span className="text-[11px] font-medium text-zinc-500">笔记</span>
        <span className="ml-auto text-[10px] text-zinc-600">{draft.length}</span>
      </div>
      <textarea
        className="h-28 w-full resize-none border-none bg-transparent px-3 py-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-600"
        placeholder={`记录「${activeTab.name}」的相关笔记…`}
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
      />
    </div>
  );
}