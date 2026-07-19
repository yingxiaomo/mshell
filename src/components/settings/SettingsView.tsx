import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../types/protocol";
import {
  exportConnections,
  importConnections,
} from "../../lib/tauri";
import { useConnectionsStore } from "../../stores/connections";
import { useSettingsStore } from "../../stores/settings";
import { THEMES } from "../../lib/themes";

const FONT_PRESETS = [
  "Cascadia Code, Consolas, monospace",
  "Consolas, monospace",
  "JetBrains Mono, Consolas, monospace",
  "Fira Code, Consolas, monospace",
  "ui-monospace, SFMono-Regular, Menlo, monospace",
] as const;

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1 block text-xs font-medium text-zinc-400"
    >
      {children}
    </label>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-zinc-800 pb-5 last:border-b-0">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function inputClass() {
  return "w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-600";
}

export function SettingsView() {
  const settings = useSettingsStore((s) => s.settings);
  const loading = useSettingsStore((s) => s.loading);
  const saving = useSettingsStore((s) => s.saving);
  const error = useSettingsStore((s) => s.error);
  const load = useSettingsStore((s) => s.load);
  const save = useSettingsStore((s) => s.save);
  const clearCredentials = useSettingsStore((s) => s.clearCredentials);
  const reloadConnections = useConnectionsStore((s) => s.load);

  const [draft, setDraft] = useState<AppSettings>(settings);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dirty) {
      setDraft(settings);
    }
  }, [settings, dirty]);

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
    setStatus(null);
  }

  async function handleSave() {
    setStatus(null);
    try {
      await save(draft);
      setDirty(false);
      setStatus("已保存");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClearCredentials() {
    if (
      !window.confirm(
        "确定清除所有已保存的密码与密钥口令？此操作不可撤销。",
      )
    ) {
      return;
    }
    setClearing(true);
    setStatus(null);
    try {
      await clearCredentials();
      setStatus("已清除全部凭据");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setClearing(false);
    }
  }

  function downloadJson(filename: string, content: string) {
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExport(includeSecrets: boolean) {
    if (includeSecrets) {
      const ok = window.confirm(
        "将导出连接元数据与 credentialId。Windows 凭据管理器中的密码/口令不会被写入文件，需确认后继续。\n\n请输入确认：在下一提示框填写 EXPORT_SECRETS",
      );
      if (!ok) return;
      const typed = window.prompt('请输入 "EXPORT_SECRETS" 以确认：');
      if (typed !== "EXPORT_SECRETS") {
        setStatus("已取消导出（确认字符串不匹配）");
        return;
      }
    }
    setExporting(true);
    setStatus(null);
    try {
      const json = await exportConnections(
        includeSecrets,
        includeSecrets ? "EXPORT_SECRETS" : null,
      );
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`momoshell-connections-${stamp}.json`, json);
      setStatus(
        includeSecrets
          ? "已导出（仅含 credentialId，无明文密钥）"
          : "已导出连接配置",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    setStatus(null);
    try {
      const text = await file.text();
      const count = await importConnections(text);
      await reloadConnections();
      setStatus(`已导入 ${count} 条连接（密码需按需重新填写）`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">
          设置
        </h1>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
          className="rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {loading && !settings && (
          <p className="text-xs text-zinc-500">加载中…</p>
        )}
        {(error || status) && (
          <p
            className={
              status &&
              (status === "已保存" ||
                status === "已清除全部凭据" ||
                status.startsWith("已导出") ||
                status.startsWith("已导入"))
                ? "text-xs text-emerald-400"
                : "text-xs text-red-400"
            }
            role="status"
          >
            {status ?? error}
          </p>
        )}

        <Section title="外观">
          <div>
            <FieldLabel htmlFor="theme">应用外观</FieldLabel>
            <select
              id="theme"
              className={inputClass()}
              value={draft.theme}
              onChange={(e) => update("theme", e.target.value)}
            >
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="codeTheme">代码块配色</FieldLabel>
            <select
              id="codeTheme"
              className={inputClass()}
              value={draft.codeTheme}
              onChange={(e) => update("codeTheme", e.target.value)}
            >
              {THEMES.filter((t) => t.chrome !== "light").map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-zinc-600">
              控制终端背景色、编辑器语法高亮配色。
            </p>
          </div>
          <div>
            <FieldLabel htmlFor="terminalFont">终端字体</FieldLabel>
            <input
              id="terminalFont"
              list="terminal-font-presets"
              className={inputClass()}
              value={draft.terminalFont}
              onChange={(e) => update("terminalFont", e.target.value)}
            />
            <datalist id="terminal-font-presets">
              {FONT_PRESETS.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div>
            <FieldLabel htmlFor="terminalFontSize">终端字号</FieldLabel>
            <input
              id="terminalFontSize"
              type="number"
              min={8}
              max={48}
              className={inputClass()}
              value={draft.terminalFontSize}
              onChange={(e) =>
                update(
                  "terminalFontSize",
                  Math.max(8, Math.min(48, Number(e.target.value) || 14)),
                )
              }
            />
          </div>
          <p className="text-[11px] text-zinc-600">
            终端配色目前固定为深色方案；完整主题色板将在后续版本开放。
          </p>
        </Section>

        <Section title="连接">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={draft.rememberPasswordDefault}
              onChange={(e) =>
                update("rememberPasswordDefault", e.target.checked)
              }
              className="rounded border-zinc-600"
            />
            默认记住密码
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={draft.autoReconnect}
              onChange={(e) => update("autoReconnect", e.target.checked)}
              className="rounded border-zinc-600"
            />
            断线自动重连
          </label>
          <div>
            <FieldLabel htmlFor="idleSessionMinutes">
              空闲会话保留（分钟）
            </FieldLabel>
            <input
              id="idleSessionMinutes"
              type="number"
              min={0}
              max={24 * 60}
              className={inputClass()}
              value={draft.idleSessionMinutes}
              onChange={(e) =>
                update(
                  "idleSessionMinutes",
                  Math.max(0, Number(e.target.value) || 0),
                )
              }
            />
            <p className="mt-1 text-[11px] text-zinc-600">
              预留字段：当前版本会话不会因空闲自动断开。
            </p>
          </div>
        </Section>

        <Section title="行为">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={draft.switchToFilesOnOpen}
              onChange={(e) =>
                update("switchToFilesOnOpen", e.target.checked)
              }
              className="rounded border-zinc-600"
            />
            打开会话后切换到文件侧栏
          </label>
        </Section>

        <Section title="路径">
          <div>
            <FieldLabel htmlFor="sshConfigPath">SSH config 路径</FieldLabel>
            <input
              id="sshConfigPath"
              className={inputClass()}
              placeholder="默认 ~/.ssh/config"
              value={draft.sshConfigPath ?? ""}
              onChange={(e) =>
                update(
                  "sshConfigPath",
                  e.target.value.trim() === "" ? null : e.target.value,
                )
              }
            />
          </div>
          <div>
            <FieldLabel htmlFor="defaultDownloadDir">
              默认下载目录
            </FieldLabel>
            <input
              id="defaultDownloadDir"
              className={inputClass()}
              placeholder="系统默认"
              value={draft.defaultDownloadDir ?? ""}
              onChange={(e) =>
                update(
                  "defaultDownloadDir",
                  e.target.value.trim() === "" ? null : e.target.value,
                )
              }
            />
          </div>
        </Section>

        <Section title="导入 / 导出">
          <p className="text-xs text-zinc-500">
            导出连接元数据为 JSON。默认不包含密钥；即便勾选「含 credentialId」也不会写出 Windows
            凭据管理器中的明文密码（跨机器导入后需重新输入密码）。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={exporting}
              onClick={() => void handleExport(false)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {exporting ? "导出中…" : "导出连接"}
            </button>
            <button
              type="button"
              disabled={exporting}
              onClick={() => void handleExport(true)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
            >
              导出（含 credentialId）
            </button>
            <button
              type="button"
              disabled={importing}
              onClick={() => importInputRef.current?.click()}
              className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {importing ? "导入中…" : "导入连接"}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImportFile(f);
              }}
            />
          </div>
        </Section>

        <Section title="安全">
          <p className="text-xs text-zinc-500">
            清除 Windows 凭据管理器中由 momoshell 保存的密码与密钥口令（按已知连接记录遍历删除）。
          </p>
          <button
            type="button"
            disabled={clearing}
            onClick={() => void handleClearCredentials()}
            className="rounded border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/40 disabled:opacity-50"
          >
            {clearing ? "清除中…" : "清除全部凭据"}
          </button>
        </Section>
      </div>
    </div>
  );
}
