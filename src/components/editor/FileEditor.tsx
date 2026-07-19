import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { sftpReadText, sftpWriteText } from "../../lib/tauri";
import { useSettingsStore } from "../../stores/settings";
import { themeByKey } from "../../lib/themes";

function codemirrorExtensions(themeKey: string) {
  const base = [basicSetup, keymap.of([indentWithTab])];
  // Light themes: no dark extension so CodeMirror defaults to browser colors
  const t = themeByKey(themeKey);
  if (t.chrome !== "light") base.push(oneDark);
  return base;
}

export type FileEditorProps = {
  sessionId: string;
  remotePath: string;
  filename: string;
  onClose: () => void;
};

export function FileEditor({
  sessionId,
  remotePath,
  filename,
  onClose,
}: FileEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Encode/decode base64
  const b64Encode = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  };
  const b64Decode = (b64: string) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    const themeKey = useSettingsStore.getState().settings.codeTheme;
    void sftpReadText(sessionId, remotePath).then(
      (b64) => {
        if (!editorRef.current) return;
        const doc = b64Decode(b64);
        const state = EditorState.create({
          doc,
          extensions: codemirrorExtensions(themeKey),
        });
        const view = new EditorView({ state, parent: editorRef.current });
        viewRef.current = view;
        setLoading(false);
      },
      (err) => {
        setError(String(err));
        setLoading(false);
      },
    );

    // Live theme reactivity: recreate view without re-fetching file.
    const unsub = useSettingsStore.subscribe((s, prev) => {
      if (s.settings.codeTheme === prev.settings.codeTheme) return;
      if (!viewRef.current) return;
      const doc = viewRef.current.state.doc.toString();
      viewRef.current.destroy();
      const state = EditorState.create({
        doc,
        extensions: codemirrorExtensions(s.settings.theme),
      });
      const el = editorRef.current;
      if (!el) return;
      viewRef.current = new EditorView({ state, parent: el });
    });

    return () => {
      unsub();
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [sessionId, remotePath]);

  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    setSaving(true);
    setError(null);
    try {
      const content = view.state.doc.toString();
      await sftpWriteText(sessionId, remotePath, b64Encode(content));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [sessionId, remotePath]);

  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
        <span className="truncate text-xs font-medium text-zinc-300">
          {filename}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {error && <span className="text-xs text-red-400">{error}</span>}
          <button
            type="button"
            disabled={saving || loading}
            className="rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            onClick={() => void handleSave()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      </div>
      {loading && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-zinc-500">加载中…</p>
        </div>
      )}
      {error && !loading && !saving && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-red-400">错误: {error}</p>
        </div>
      )}
      <div ref={editorRef} className="min-h-0 flex-1 overflow-auto" />
    </div>
  );
}
