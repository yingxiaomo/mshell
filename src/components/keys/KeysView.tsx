import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Key, KeyRound, Plus, Upload } from "lucide-react";
import { cmd, commands, type SshKeyInfo, type AgentStatus } from "../../lib/commands";
import { useSessionsStore } from "../../stores/sessions";
import { showToast } from "../ui/Toast";

export function KeysView() {
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [genOpen, setGenOpen] = useState(false);
  const [genName, setGenName] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [deploying, setDeploying] = useState<string | null>(null);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const tabs = useSessionsStore((s) => s.tabs);
  const activeSession = useMemo(() => {
    const tab = tabs.find((t) => t.sessionId === activeSessionId);
    return tab && !tab.disconnected ? { sessionId: tab.sessionId, name: tab.name } : null;
  }, [tabs, activeSessionId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [k, a] = await Promise.all([
        cmd(commands.listSshKeys),
        cmd(commands.sshAgentStatus).catch(() => ({ running: false, keysLoaded: null })),
      ]);
      setKeys(k);
      setAgent(a);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleGenerate() {
    try {
      const path = genName.trim()
        ? `~/.ssh/${genName.trim().replace(/[^a-zA-Z0-9_-]/g, "_")}`
        : undefined;
      await cmd(commands.generateKeypair, { path, comment: "mshell" });
      showToast("密钥已生成", "success");
      setGenOpen(false);
      setGenName("");
      void load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function handleCopy(path: string, name: string) {
    try {
      const pubkey = await cmd(commands.readSshPubkey, { path: `${path}.pub` });
      await navigator.clipboard.writeText(pubkey);
      setCopiedKey(name);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function handleDeploy(name: string, pubPath: string) {
    if (!activeSession) { showToast("需要连接一个活动会话才能部署", "info"); return; }
    setDeploying(name);
    try {
      const added = await cmd(commands.deployPublicKey, {
        sessionId: activeSession.sessionId,
        pubPath,
      });
      showToast(added ? `公钥已部署到 ${activeSession.name}` : `公钥已在 ${activeSession.name} 上存在`, "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally { setDeploying(null); }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">密钥</h1>
        <button type="button" onClick={() => setGenOpen(true)}
          className="flex items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500">
          <Plus className="h-3.5 w-3.5" />生成
        </button>
      </div>

      {/* Agent 状态 */}
      {agent && (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
          <div className={`h-2 w-2 rounded-full ${agent.running ? "bg-emerald-500" : "bg-zinc-600"}`} />
          <span className="text-zinc-400">SSH Agent</span>
          <span className={agent.running ? "text-emerald-400" : "text-zinc-500"}>
            {agent.running ? (agent.keysLoaded != null ? `已加载 ${agent.keysLoaded} 个密钥` : "运行中") : "未运行"}
          </span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <p className="text-sm text-zinc-500">加载中…</p>
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Key className="h-8 w-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">~/.ssh/ 中未找到密钥</p>
            <p className="text-xs text-zinc-600">点击「生成」创建新的 SSH 密钥对</p>
          </div>
        ) : keys.map((k) => (
          <div key={k.path} className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                  <span className="truncate text-sm font-medium text-zinc-200">{k.name}</span>
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">{k.keyType}</span>
                  {k.hasPubkey && (
                    <span className="shrink-0 rounded bg-emerald-900/30 px-1.5 py-0.5 text-[10px] text-emerald-400">✓ 公钥</span>
                  )}
                </div>
                {k.fingerprint && (
                  <p className="mt-0.5 font-mono text-[11px] text-zinc-500 truncate">{k.fingerprint}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                {k.hasPubkey && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCopy(k.path, k.name)}
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                      title={copiedKey === k.name ? "已复制" : "复制公钥"}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={deploying === k.name || !activeSession}
                      onClick={() => void handleDeploy(k.name, `${k.path}.pub`)}
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
                      title={activeSession ? `部署到 ${activeSession.name}` : "需要连接一个活动会话"}
                    >
                      <Upload className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* 生成密钥弹窗 */}
      {genOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setGenOpen(false); }}>
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-base font-semibold text-zinc-100">生成 SSH 密钥</h2>
            <p className="mb-4 text-xs text-zinc-500">将生成 ed25519 密钥对到 ~/.ssh/ 目录</p>

            <label className="mb-1 block text-[11px] font-medium text-zinc-400">名称（可选）</label>
            <input className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600"
              placeholder="留空使用默认名 mshell_ed25519" value={genName} onChange={(e) => setGenName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setGenOpen(false); if (e.key === "Enter") { e.preventDefault(); void handleGenerate(); } }} />

            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                onClick={() => setGenOpen(false)}>取消</button>
              <button type="button" className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
                onClick={() => void handleGenerate()}>生成</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}