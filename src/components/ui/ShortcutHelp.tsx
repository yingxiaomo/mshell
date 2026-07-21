import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";

const SHORTCUTS: { keys: string; desc: string; group: string }[] = [
  { group: "全局", keys: "Ctrl+P / Ctrl+K", desc: "打开命令面板" },
  { group: "全局", keys: "Ctrl+Shift+P", desc: "打开命令面板" },
  { group: "全局", keys: "Esc", desc: "关闭弹窗 / 搜索" },
  { group: "终端", keys: "Ctrl+F", desc: "终端内搜索" },
  { group: "终端", keys: "Ctrl+V", desc: "粘贴" },
  { group: "终端", keys: "Ctrl+Shift+C", desc: "复制选中" },
  { group: "终端", keys: "Tab / Shift+Tab", desc: "搜索结果下/上一条" },
  { group: "编辑器", keys: "Ctrl+F", desc: "查找" },
  { group: "编辑器", keys: "Ctrl+H", desc: "替换" },
  { group: "编辑器", keys: "F3 / Ctrl+G", desc: "下一个匹配" },
  { group: "连接", keys: "双击连接", desc: "打开会话" },
  { group: "文件", keys: "双击文件", desc: "在编辑器打开" },
  { group: "文件", keys: "右键", desc: "上传 / 下载 / 新建 / 删除" },
];

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ? without modifiers, not while typing in input
      if (e.key !== "?" && e.key !== "F1") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.closest?.(".cm-editor, .xterm"))
      ) {
        if (e.key === "?") return;
      }
      if (e.key === "?" && (e.ctrlKey || e.metaKey || e.altKey)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        title="快捷键 (? / F1)"
        aria-label="快捷键帮助"
        onClick={() => setOpen(true)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
      >
        <Keyboard className="h-4 w-4" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-help-title"
            className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2
                id="shortcut-help-title"
                className="text-base font-semibold text-zinc-100"
              >
                快捷键
              </h2>
              <button
                type="button"
                className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                onClick={() => setOpen(false)}
              >
                关闭
              </button>
            </div>

            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              {["全局", "终端", "编辑器", "连接", "文件"].map((group) => {
                const rows = SHORTCUTS.filter((s) => s.group === group);
                if (rows.length === 0) return null;
                return (
                  <div key={group}>
                    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                      {group}
                    </h3>
                    <ul className="space-y-1">
                      {rows.map((s) => (
                        <li
                          key={s.keys + s.desc}
                          className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-800/50"
                        >
                          <span className="text-zinc-300">{s.desc}</span>
                          <kbd className="shrink-0 rounded border border-zinc-700 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-400">
                            {s.keys}
                          </kbd>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>

            <p className="mt-4 text-center text-[11px] text-zinc-600">
              按 <kbd className="rounded border border-zinc-700 px-1">?</kbd> 或{" "}
              <kbd className="rounded border border-zinc-700 px-1">F1</kbd>{" "}
              开关此面板
            </p>
          </div>
        </div>
      )}
    </>
  );
}
