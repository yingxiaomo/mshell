/**
 * Global Ctrl+F / Ctrl+H routing.
 * Single capture-phase listener — terminal and editor never fight.
 *
 * Priority:
 * 1. Focus inside editor  → editor find (Ctrl+H = replace)
 * 2. Focus inside terminal → terminal find
 * 3. Otherwise              → terminal find if registered (editor closed case)
 */
type FindHandler = (opts: { replace?: boolean }) => void;

let editorHandler: FindHandler | null = null;
let terminalHandler: FindHandler | null = null;
let listening = false;

function onKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key !== "f" && key !== "h") return;

  const target = e.target as HTMLElement | null;

  // Ignore pure chrome (sidebar / activity bar / native dialogs).
  if (
    target?.closest?.(
      "aside, nav, [role='dialog']:not([data-editor-search]):not([data-terminal-search])",
    ) &&
    !target?.closest?.(
      "[data-editor-root], [data-terminal-root], .cm-editor, .xterm",
    )
  ) {
    return;
  }

  const inEditor = !!target?.closest?.(
    "[data-editor-root], [data-editor-search], .cm-editor, .cm-content, .cm-scroller",
  );
  const inTerminal = !!target?.closest?.(
    "[data-terminal-root], [data-terminal-search], .xterm, .xterm-helper-textarea, .xterm-screen",
  );

  const replace = key === "h";
  let handled = false;

  if (inEditor && editorHandler) {
    editorHandler({ replace });
    handled = true;
  } else if (inTerminal && terminalHandler) {
    if (!replace) {
      terminalHandler({ replace: false });
      handled = true;
    }
  } else if (terminalHandler && !replace) {
    // Editor closed or focus on body/title — terminal find.
    terminalHandler({ replace: false });
    handled = true;
  } else if (editorHandler && replace) {
    editorHandler({ replace: true });
    handled = true;
  }

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function ensureListening() {
  if (listening) return;
  listening = true;
  document.addEventListener("keydown", onKey, true);
}

function maybeStopListening() {
  if (editorHandler || terminalHandler) return;
  if (!listening) return;
  document.removeEventListener("keydown", onKey, true);
  listening = false;
}

export function registerEditorFind(handler: FindHandler | null) {
  editorHandler = handler;
  if (handler) ensureListening();
  else maybeStopListening();
}

export function registerTerminalFind(handler: FindHandler | null) {
  terminalHandler = handler;
  if (handler) ensureListening();
  else maybeStopListening();
}
