import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, Save, FileText, Pencil } from "lucide-react";
import { cmd, commands } from "../../lib/commands";
import { showToast } from "../ui/Toast";

type HostEntry = {
  name: string;
  lines: string[];
  isNew?: boolean;
};

export function SshConfigView() {
  const [raw, setRaw] = useState("");
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const parseHosts = useCallback((text: string) => {
    // Split by Host lines
    const result: HostEntry[] = [];
    const lines = text.split("\n");
    let current: HostEntry | null = null;
    for (const line of lines) {
      if (/^Host\s/i.test(line) && current) {
        result.push(current);
        current = null;
      }
      if (/^Host\s/i.test(line)) {
        const name = line.replace(/^Host\s+/i, "").trim();
        current = { name, lines: [line] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) result.push(current);
    return result;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const text = await cmd(commands.readSshConfigText, {});
      setRaw(text);
      setHosts(parseHosts(text));
      setDraft(text);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally { setLoading(false); }
  }, [parseHosts]);

  useEffect(() => { void load(); }, [load]);

  // Generate text from hosts back to config format
  const generate = useCallback(() => {
    return hosts.map((h) => h.lines.join("\n")).join("\n\n");
  }, [hosts]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const content = editMode ? draft : generate();
      await cmd(commands.writeSshConfigText, { content });
      showToast("SSH 配置已保存", "success");
      setRaw(content);
      setHosts(parseHosts(content));
      setEditMode(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally { setSaving(false); }
  }, [editMode, draft, generate, parseHosts]);

  const addHost = useCallback(() => {
    const entry: HostEntry = {
      name: "new-server",
      lines: ["Host new-server", "    HostName 192.168.1.100", "    User root", "    Port 22", '    IdentityFile ~/.ssh/id_ed25519'],
      isNew: true,
    };
    setHosts((prev) => [...prev, entry]);
  }, []);

  const removeHost = useCallback((idx: number) => {
    setHosts((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const updateField = useCallback((idx: number, key: string, value: string) => {
    setHosts((prev) => {
      const h = { ...prev[idx]! };
      if (key === "name") {
        h.name = value;
        h.lines[0] = `Host ${value}`;
      } else {
        const existingIdx = h.lines.findIndex((l) => l.trim().toLowerCase().startsWith(key.toLowerCase()));
        if (existingIdx >= 0) {
          h.lines[existingIdx] = h.lines[existingIdx].replace(/^(\s*\S+\s+).*$/, `$1${value}`);
        } else {
          h.lines.push(`    ${key} ${value}`);
        }
      }
      const copy = [...prev];
      copy[idx] = h;
      return copy;
    });
  }, []);

  const toggleCollapse = useCallback((name: string) => {
    setCollapsed((s) => {
      const c = new Set(s);
      if (c.has(name)) c.delete(name); else c.add(name);
      return c;
    });
  }, []);

  if (loading) return <div className="flex h-full items-center justify-center p-4"><p className="text-sm text-zinc-500">加载中…</p></div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="flex items-center gap-1.5 text-sm font-semibold tracking-wide text-zinc-200">
          <FileText className="h-4 w-4 text-zinc-400" /> SSH 配置
        </h1>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={addHost}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
            <Plus className="h-3 w-3" />添加
          </button>
          <button type="button" onClick={() => { setEditMode(!editMode); if (!editMode) setDraft(raw); }}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${editMode ? "bg-sky-600/20 text-sky-400" : "text-zinc-300 hover:bg-zinc-800"}`}>
            <Pencil className="h-3 w-3" />{editMode ? "结构化" : "编辑"}
          </button>
          <button type="button" disabled={saving} onClick={() => void save()}
            className="flex items-center gap-1 rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            <Save className="h-3 w-3" />{saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>

      {editMode ? (
        <textarea ref={textareaRef} value={draft} onChange={(e) => setDraft(e.target.value)}
          className="flex-1 border-none bg-zinc-950 p-4 font-mono text-xs text-zinc-200 outline-none resize-none"
          spellCheck={false} />
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {hosts.length === 0 && (
            <p className="text-center text-sm text-zinc-500 py-8">~/.ssh/config 为空或不存在</p>
          )}
          <div className="space-y-1.5">
            {hosts.map((h, idx) => {
              const fold = collapsed.has(h.name);
              return (
                <div key={`${h.name}-${idx}`} className={`rounded-md border ${h.isNew ? "border-sky-700/60" : "border-zinc-800"} bg-zinc-900/60`}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button type="button" onClick={() => toggleCollapse(h.name)}
                      className="text-[10px] text-zinc-500 hover:text-zinc-300">{fold ? "▶" : "▼"}</button>
                    <input value={h.name} onChange={(e) => updateField(idx, "name", e.target.value)}
                      className="min-w-0 flex-1 bg-transparent text-sm font-medium text-zinc-100 outline-none" />
                    <button type="button" onClick={() => removeHost(idx)}
                      className="rounded px-1 py-0.5 text-[11px] text-zinc-600 hover:text-red-400">✕</button>
                  </div>
                  {!fold && (
                    <div className="space-y-1 border-t border-zinc-800 px-3 py-2">
                      {parseField(h, "hostname", updateField, idx)}
                      {parseField(h, "user", updateField, idx, "root")}
                      {parseField(h, "port", updateField, idx, "22")}
                      {parseField(h, "identityfile", updateField, idx)}
                      {parseField(h, "proxyjump", updateField, idx)}
                      {parseField(h, "certificatefile", updateField, idx)}
                      <p className="text-[10px] text-zinc-600">其他字段将在编辑模式中显示</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function parseField(
  h: HostEntry,
  key: string,
  update: (idx: number, k: string, v: string) => void,
  idx: number,
  fallback?: string,
) {
  const val = findField(h, key);
  const label = key.charAt(0).toUpperCase() + key.slice(1).replace(/file$/i, " File");
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 text-zinc-500">{label}</span>
      <input value={val ?? ""} onChange={(e) => update(idx, key, e.target.value)}
        placeholder={fallback ?? `未设置`}
        className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-200 outline-none focus:border-sky-600 placeholder:text-zinc-700" />
    </div>
  );
}

function findField(h: HostEntry, key: string): string | undefined {
  const re = new RegExp(`^\\s+${key}\\s+`, "i");
  const line = h.lines.find((l) => re.test(l));
  if (!line) return undefined;
  return line.replace(re, "").trim();
}
