import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppSettings, GeneratedKey, KnownHostEntry } from "../../types/protocol";
import { cmd, commands } from "../../lib/commands";
import { useConnectionsStore } from "../../stores/connections";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTriggersStore, validateTriggerPattern } from "../../stores/triggers";
import { THEMES } from "../../lib/themes";
import { parseITermTheme, parseVSCodeTheme } from "../../lib/themes/import";
import type { EditorTerminalTheme } from "../../lib/themes/types";

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
  const [importingKh, setImportingKh] = useState(false);
  const [knownHosts, setKnownHosts] = useState<KnownHostEntry[]>([]);
  const [genKey, setGenKey] = useState<GeneratedKey | null>(null);
  const [keygenBusy, setKeygenBusy] = useState(false);
  const [deployBusy, setDeployBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 导入的主题（localStorage 持久化）
  const [importedThemes, setImportedThemes] = useState<EditorTerminalTheme[]>(() => {
    try {
      const raw = localStorage.getItem("mshell.imported-themes.v1");
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return [];
  });

  const allThemes = [...THEMES, ...importedThemes];

  async function loadKnownHosts() {
    try {
      setKnownHosts(await cmd(commands.listKnownHosts));
    } catch {
      /* non-fatal; leave list as-is */
    }
  }
  useEffect(() => {
    void loadKnownHosts();
  }, []);

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

  async function handleImportKnownHosts() {
    setImportingKh(true);
    setStatus(null);
    try {
      const n = await cmd(commands.importKnownHosts, {});
      setStatus(`已导入 ${n} 条主机密钥（来自 ~/.ssh/known_hosts）`);
      await loadKnownHosts();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setImportingKh(false);
    }
  }

  async function handleRemoveHost(host: string) {
    try {
      await cmd(commands.removeKnownHost, { host });
      setKnownHosts((h) => h.filter((e) => e.host !== host));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleGenerateKeypair() {
    setKeygenBusy(true);
    setStatus(null);
    try {
      const k = await cmd(commands.generateKeypair, {});
      setGenKey(k);
      setStatus("已生成密钥对");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setKeygenBusy(false);
    }
  }

  async function handleDeployPublicKey() {
    const s = useSessionsStore.getState();
    const active = s.tabs.find((t) => t.sessionId === s.activeSessionId);
    if (!active || active.disconnected) {
      setStatus("请先打开一个 SSH 会话，公钥会部署到该服务器");
      return;
    }
    const picked = await open({
      title: "选择要部署的公钥（.pub）",
      filters: [{ name: "SSH 公钥", extensions: ["pub"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    setDeployBusy(true);
    setStatus(null);
    try {
      const added = await cmd(commands.deployPublicKey, { sessionId: active.sessionId, pubPath: picked });
      setStatus(added ? `已部署公钥到「${active.name}」` : `公钥已在「${active.name}」，无需重复部署`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setDeployBusy(false);
    }
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
      const json = await cmd(commands.exportConnections, { includeSecrets, confirm: includeSecrets ? "EXPORT_SECRETS" : null });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`mshell-connections-${stamp}.json`, json);
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
      const count = await cmd(commands.importConnections, { json: text });
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
        {loading && (
          <div className="flex items-center justify-center py-12"><p className="text-xs text-zinc-500">加载设置…</p></div>
        )}
        {(error || status) && (
          <p
            className={
              status &&
              (status === "已保存" ||
                status === "已清除全部凭据" ||
                status.startsWith("已导出") ||
                status.startsWith("已导入") ||
                status.startsWith("已生成") ||
                status.startsWith("已部署") ||
                status.startsWith("公钥已在"))
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
              {allThemes.map((t, i) => (
                <option key={`${t.key}-${i}`} value={t.key}>
                  {t.label}{i >= THEMES.length ? " (导入)" : ""}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-zinc-600">
              语法高亮配色。应用外观为浅色时自动使用对应的浅色高亮，保证白底可读。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="file"
                accept=".json,.itermcolors,.tmTheme"
                className="hidden"
                ref={importInputRef}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    let theme = parseITermTheme(text) || parseVSCodeTheme(text);
                    if (!theme) { setStatus("无法解析该文件，请确保是 iTerm2 或 VS Code 主题 JSON"); return; }
                    const updated = [...importedThemes, theme];
                    setImportedThemes(updated);
                    localStorage.setItem("mshell.imported-themes.v1", JSON.stringify(updated));
                    setStatus(`已导入主题：${theme.label}`);
                  } catch (err) {
                    setStatus(`导入失败：${err instanceof Error ? err.message : String(err)}`);
                  }
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                onClick={() => importInputRef.current?.click()}
              >
                导入主题
              </button>
              {importedThemes.length > 0 && (
                <button
                  type="button"
                  className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-red-400"
                  onClick={() => {
                    setImportedThemes([]);
                    localStorage.removeItem("mshell.imported-themes.v1");
                    setStatus("已清除导入的主题");
                  }}
                >
                  清除导入
                </button>
              )}
            </div>
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
          <div>
            <FieldLabel htmlFor="terminalScrollback">
              终端回滚缓冲（行）
            </FieldLabel>
            <input
              id="terminalScrollback"
              type="number"
              min={100}
              max={100000}
              step={500}
              className={inputClass()}
              value={draft.terminalScrollback}
              onChange={(e) =>
                update(
                  "terminalScrollback",
                  Math.max(
                    100,
                    Math.min(100_000, Number(e.target.value) || 5000),
                  ),
                )
              }
            />
            <p className="mt-1 text-[11px] text-zinc-600">
              已打开的终端需重开会话后才会应用新缓冲大小。
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={draft.copyOnSelect}
              onChange={(e) => update("copyOnSelect", e.target.checked)}
              className="rounded border-zinc-600"
            />
            选中即复制
          </label>
          <p className="text-[11px] text-zinc-600">
            终端内：Ctrl+C 复制选区，Ctrl+V 粘贴；也可用右键 / 中键粘贴。
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
            清除 Windows 凭据管理器中由 mshell 保存的密码与密钥口令（按已知连接记录遍历删除）。
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

        <Section title="密钥对">
          <p className="text-xs text-zinc-500">
            生成一对新的 ed25519 密钥（默认 <code className="text-zinc-400">~/.ssh/mshell_ed25519</code>，无口令）。
            生成后可复制公钥，或用「部署公钥」按钮推送到已连接的服务器。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={keygenBusy}
              onClick={() => void handleGenerateKeypair()}
              className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {keygenBusy ? "生成中…" : "生成密钥对"}
            </button>
            <button
              type="button"
              disabled={deployBusy}
              onClick={() => void handleDeployPublicKey()}
              title="选择一个 .pub 公钥，部署到当前已连接的会话（写入远端 authorized_keys，幂等）"
              className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {deployBusy ? "部署中…" : "部署公钥到当前会话"}
            </button>
          </div>
          {genKey && (
            <div className="mt-1 space-y-1">
              <p className="text-[11px] text-zinc-500 break-all">
                私钥：<code className="text-zinc-400">{genKey.privatePath}</code>
              </p>
              <div className="flex items-start gap-2">
                <textarea
                  readOnly
                  value={genKey.publicKey}
                  className="h-16 w-full resize-none rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] text-zinc-400"
                />
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(genKey.publicKey)}
                  className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  复制公钥
                </button>
              </div>
            </div>
          )}
        </Section>

        <Section title="主机密钥">
          <p className="text-xs text-zinc-500">
            从 OpenSSH 的 <code className="text-zinc-400">~/.ssh/known_hosts</code> 导入已信任的主机指纹
            （哈希化的主机名条目会被跳过）。
          </p>
          <button
            type="button"
            disabled={importingKh}
            onClick={() => void handleImportKnownHosts()}
            className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {importingKh ? "导入中…" : "导入 known_hosts"}
          </button>

          {knownHosts.length > 0 && (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {knownHosts.map((e) => (
                <li
                  key={e.host}
                  className="flex items-center justify-between gap-2 rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1"
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs text-zinc-300">{e.host}</div>
                    <div className="truncate font-mono text-[10px] text-zinc-500">
                      {e.keyType} · {e.fingerprint}
                    </div>
                  </div>
                  <button
                    type="button"
                    title="删除此信任条目"
                    onClick={() => void handleRemoveHost(e.host)}
                    className="shrink-0 rounded border border-red-900/60 bg-red-950/30 px-2 py-0.5 text-[11px] text-red-300 hover:bg-red-900/40"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <TriggersSection />
      </div>
    </div>
  );
}

/** Terminal trigger rules — regex → alert when it appears in output. */
function TriggersSection() {
  const items = useTriggersStore((s) => s.items);
  const add = useTriggersStore((s) => s.add);
  const remove = useTriggersStore((s) => s.remove);
  const toggle = useTriggersStore((s) => s.toggle);
  const [name, setName] = useState("");
  const [pattern, setPattern] = useState("");
  const patternErr = pattern ? validateTriggerPattern(pattern) : null;

  function submit() {
    if (!name.trim() || !pattern || patternErr) return;
    add(name, pattern);
    setName("");
    setPattern("");
  }

  return (
    <Section title="触发器">
      <p className="text-xs text-zinc-500">
        当终端输出匹配到正则时弹出提醒（含响铃）。例如日志里出现{" "}
        <code className="text-zinc-400">error|panic|OOM</code> 时告警。
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <input
          className={inputClass() + " min-w-[8rem] flex-1"}
          placeholder="名称，如「错误告警」"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={inputClass() + " min-w-[10rem] flex-[2] font-mono"}
          placeholder="正则，如 error|panic|OOM"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        />
        <button
          type="button"
          disabled={!name.trim() || !pattern || !!patternErr}
          onClick={submit}
          className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          添加
        </button>
      </div>
      {patternErr && <p className="text-[11px] text-red-400">正则无效：{patternErr}</p>}
      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
              <input type="checkbox" checked={t.enabled} onChange={() => toggle(t.id)} title="启用/停用" />
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-200" title={t.name}>{t.name}</span>
              <code className="min-w-0 max-w-[12rem] truncate font-mono text-[11px] text-zinc-500" title={t.pattern}>{t.pattern}</code>
              <button type="button" className="shrink-0 text-zinc-600 hover:text-red-400" title="删除" onClick={() => remove(t.id)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
