import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import {
  SearchQuery,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { sftpReadText, sftpWriteText } from "../../lib/tauri";
import { useSettingsStore } from "../../stores/settings";
import {
  codeMirrorThemeExtensions,
  languageExtensionForPath,
} from "../../lib/themes";
import { registerEditorFind } from "../../lib/findHotkey";

function codemirrorExtensions(
  codeTheme: string,
  appChrome: string,
  filePath: string,
  doc: string,
  onDocChanged: () => void,
) {
  const language = languageExtensionForPath(filePath, doc);
  return [
    basicSetup,
    // Search state for findNext/replaceAll; panel UI is React (terminal-style).
    search({ top: true }),
    // Block CodeMirror's default Mod-f / Mod-h panel (we use our own overlay).
    keymap.of([
      { key: "Mod-f", run: () => true, preventDefault: true },
      { key: "Mod-h", run: () => true, preventDefault: true },
      { key: "Mod-Alt-f", run: () => true, preventDefault: true },
      indentWithTab,
    ]),
    ...(language ? [language] : []),
    ...codeMirrorThemeExtensions(codeTheme, appChrome),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onDocChanged();
    }),
  ];
}

export type FileEditorProps = {
  sessionId: string;
  remotePath: string;
  filename: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  compactHeader?: boolean;
  /** When false, this tab is hidden — do not claim Ctrl+F. */
  active?: boolean;
};

export function FileEditor({
  sessionId,
  remotePath,
  filename,
  onClose,
  onDirtyChange,
  compactHeader = false,
  active = true,
}: FileEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const baselineRef = useRef<string>("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [searchOpen, setSearchOpen] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);

  const findTextRef = useRef(findText);
  findTextRef.current = findText;
  const replaceTextRef = useRef(replaceText);
  replaceTextRef.current = replaceText;
  const caseRef = useRef(caseSensitive);
  caseRef.current = caseSensitive;
  const regexRef = useRef(useRegex);
  regexRef.current = useRegex;
  const wordRef = useRef(wholeWord);
  wordRef.current = wholeWord;

  const b64Encode = (s: string) => {
    const bytes = new TextEncoder().encode(s);
    let binary = "";
    for (let i = 0; i < bytes.length; i++)
      binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  };
  const b64Decode = (b64: string) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  const emitDirty = useCallback((dirty: boolean) => {
    onDirtyChangeRef.current?.(dirty);
  }, []);

  const applyQuery = useCallback((searchStr: string, replaceStr: string) => {
    const view = viewRef.current;
    if (!view) return;
    const query = new SearchQuery({
      search: searchStr,
      replace: replaceStr,
      caseSensitive: caseRef.current,
      regexp: regexRef.current,
      wholeWord: wordRef.current,
    });
    view.dispatch({ effects: setSearchQuery.of(query) });
  }, []);

  const doFindNext = useCallback(
    (text?: string) => {
      const view = viewRef.current;
      if (!view) return;
      const q = text ?? findTextRef.current;
      applyQuery(q, replaceTextRef.current);
      if (!q) return;
      findNext(view);
    },
    [applyQuery],
  );

  const doFindPrev = useCallback(
    (text?: string) => {
      const view = viewRef.current;
      if (!view) return;
      const q = text ?? findTextRef.current;
      applyQuery(q, replaceTextRef.current);
      if (!q) return;
      findPrevious(view);
    },
    [applyQuery],
  );

  const doReplaceOne = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    applyQuery(findTextRef.current, replaceTextRef.current);
    replaceNext(view);
  }, [applyQuery]);

  const doReplaceAll = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    applyQuery(findTextRef.current, replaceTextRef.current);
    replaceAll(view);
  }, [applyQuery]);

  const openSearch = useCallback((withReplace: boolean) => {
    setReplaceMode(withReplace);
    setSearchOpen(true);
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    viewRef.current?.focus();
  }, []);

  // Only the visible editor tab claims Ctrl+F / Ctrl+H.
  useEffect(() => {
    if (!active) return;
    registerEditorFind(({ replace }) => openSearch(!!replace));
    return () => registerEditorFind(null);
  }, [active, openSearch]);

  useEffect(() => {
    if (!active) setSearchOpen(false);
  }, [active]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      if (input.value) input.select();
    });
  }, [searchOpen, replaceMode]);

  const mountEditor = useCallback(
    (doc: string, codeTheme: string, appChrome: string, path: string) => {
      const el = editorRef.current;
      if (!el) return;
      viewRef.current?.destroy();
      viewRef.current = null;
      el.innerHTML = "";
      baselineRef.current = doc;
      const state = EditorState.create({
        doc,
        extensions: codemirrorExtensions(
          codeTheme,
          appChrome,
          path,
          doc,
          () => {
            queueMicrotask(() => {
              const v = viewRef.current;
              if (!v) return;
              const dirty = v.state.doc.toString() !== baselineRef.current;
              emitDirty(dirty);
            });
          },
        ),
      });
      viewRef.current = new EditorView({ state, parent: el });
      emitDirty(false);
    },
    [emitDirty],
  );

  useEffect(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;
    const { codeTheme, theme: appChrome } =
      useSettingsStore.getState().settings;
    void sftpReadText(sessionId, remotePath).then(
      (b64) => {
        if (cancelled || !editorRef.current) return;
        mountEditor(b64Decode(b64), codeTheme, appChrome, remotePath);
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      },
    );

    const unsub = useSettingsStore.subscribe((s, prev) => {
      if (
        s.settings.codeTheme === prev.settings.codeTheme &&
        s.settings.theme === prev.settings.theme
      ) {
        return;
      }
      if (!viewRef.current) return;
      const doc = viewRef.current.state.doc.toString();
      const baseline = baselineRef.current;
      mountEditor(doc, s.settings.codeTheme, s.settings.theme, remotePath);
      baselineRef.current = baseline;
      emitDirty(doc !== baseline);
    });

    return () => {
      cancelled = true;
      unsub();
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, remotePath]);

  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    setSaving(true);
    setError(null);
    try {
      const content = view.state.doc.toString();
      await sftpWriteText(sessionId, remotePath, b64Encode(content));
      baselineRef.current = content;
      emitDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [sessionId, remotePath, emitDirty]);

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100"
      data-editor-root
    >
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-1">
        {!compactHeader ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-sky-600/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-400">
              编辑器
            </span>
            <span className="truncate text-xs font-medium text-zinc-200">
              {filename}
            </span>
          </div>
        ) : (
          <span
            className="truncate text-[11px] text-zinc-500"
            title={remotePath}
          >
            {remotePath}
          </span>
        )}
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
          {!compactHeader && (
            <button
              type="button"
              className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              onClick={onClose}
            >
              关闭
            </button>
          )}
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
      <div className="relative min-h-0 flex-1">
        <div
          ref={editorRef}
          className="absolute inset-0 min-h-0 overflow-hidden [&_.cm-editor]:h-full"
        />

        {/* Same style as terminal search; replace row optional (Ctrl+H). */}
        {searchOpen && (
          <div
            className="absolute inset-x-0 top-0 z-[200] flex justify-center pt-2 pointer-events-none"
            role="dialog"
            aria-label="编辑器搜索"
            data-editor-search
          >
            <div className="pointer-events-auto flex w-[min(480px,calc(100%-2rem))] flex-col gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 shadow-2xl ring-1 ring-black/20">
              <div className="flex items-center gap-1.5">
                <input
                  ref={searchInputRef}
                  data-editor-search-input
                  className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                  placeholder="查找…"
                  value={findText}
                  onChange={(e) => {
                    const v = e.target.value;
                    setFindText(v);
                    doFindNext(v);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      e.preventDefault();
                      closeSearch();
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      e.preventDefault();
                      e.shiftKey ? doFindPrev() : doFindNext();
                      return;
                    }
                    if (e.key === "F3") {
                      e.preventDefault();
                      e.shiftKey ? doFindPrev() : doFindNext();
                    }
                  }}
                />
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  title="上一个 (Shift+Tab)"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    doFindPrev();
                    searchInputRef.current?.focus();
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  title="下一个 (Tab / Enter)"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    doFindNext();
                    searchInputRef.current?.focus();
                  }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={
                    replaceMode
                      ? "rounded px-1.5 py-1 text-xs text-sky-400 hover:bg-zinc-800"
                      : "rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  }
                  title="显示替换"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setReplaceMode((v) => !v)}
                >
                  ⇄
                </button>
                <button
                  type="button"
                  className="rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={closeSearch}
                >
                  ✕
                </button>
              </div>

              {replaceMode && (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={replaceInputRef}
                    className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                    placeholder="替换为…"
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Escape") {
                        e.preventDefault();
                        closeSearch();
                        return;
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        doReplaceOne();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={doReplaceOne}
                  >
                    替换
                  </button>
                  <button
                    type="button"
                    className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={doReplaceAll}
                  >
                    全部
                  </button>
                </div>
              )}

              <div className="flex items-center gap-3 text-[11px] text-zinc-500">
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    checked={caseSensitive}
                    onChange={(e) => {
                      setCaseSensitive(e.target.checked);
                      queueMicrotask(() => doFindNext());
                    }}
                  />
                  区分大小写
                </label>
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    checked={useRegex}
                    onChange={(e) => {
                      setUseRegex(e.target.checked);
                      queueMicrotask(() => doFindNext());
                    }}
                  />
                  正则
                </label>
                <label className="flex cursor-pointer items-center gap-1">
                  <input
                    type="checkbox"
                    checked={wholeWord}
                    onChange={(e) => {
                      setWholeWord(e.target.checked);
                      queueMicrotask(() => doFindNext());
                    }}
                  />
                  整词
                </label>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
