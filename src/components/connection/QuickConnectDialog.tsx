import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { parseTarget } from "../../lib/quickConnect";

export type QuickConnectParams = {
  host: string;
  port: number;
  username: string;
  authType: "password" | "agent" | "key";
  password?: string;
  keyPath?: string;
};

const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-600";

export function QuickConnectDialog({
  open,
  onClose,
  onConnect,
}: {
  open: boolean;
  onClose: () => void;
  onConnect: (p: QuickConnectParams) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [authType, setAuthType] = useState<"password" | "agent" | "key">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget("");
    setAuthType("password");
    setPassword("");
    setKeyPath("");
    setError(null);
    setBusy(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;

  async function submit() {
    const parsed = parseTarget(target);
    if (!parsed) {
      setError("请输入 user@host 或 user@host:port");
      return;
    }
    if (authType === "key" && !keyPath.trim()) {
      setError("请选择私钥文件");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConnect({
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        authType,
        password: authType === "password" ? password : undefined,
        keyPath: authType === "key" ? keyPath.trim() : undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickKey() {
    const p = await openDialog({ multiple: false, directory: false, title: "选择私钥文件" });
    if (typeof p === "string") setKeyPath(p);
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-base font-semibold text-zinc-100">快速连接</h2>
        <p className="mb-4 text-xs text-zinc-500">临时连接，不保存到连接列表。</p>

        <label className="mb-1 block text-[11px] font-medium text-zinc-400">目标</label>
        <input
          ref={inputRef}
          className={`mb-3 ${inputClass}`}
          placeholder="root@example.com:22"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && authType !== "password") { e.preventDefault(); void submit(); } if (e.key === "Escape") onClose(); }}
        />

        <label className="mb-1 block text-[11px] font-medium text-zinc-400">认证方式</label>
        <select className={`mb-3 ${inputClass}`} value={authType} onChange={(e) => setAuthType(e.target.value as "password" | "agent" | "key")}>
          <option value="password">密码</option>
          <option value="key">私钥</option>
          <option value="agent">SSH Agent</option>
        </select>

        {authType === "password" && (
          <>
            <label className="mb-1 block text-[11px] font-medium text-zinc-400">密码</label>
            <input
              type="password"
              className={`mb-3 ${inputClass}`}
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } if (e.key === "Escape") onClose(); }}
            />
          </>
        )}

        {authType === "key" && (
          <>
            <label className="mb-1 block text-[11px] font-medium text-zinc-400">私钥文件</label>
            <div className="mb-3 flex gap-2">
              <input className={inputClass} placeholder="私钥路径" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} />
              <button type="button" className="shrink-0 rounded-md border border-zinc-700 px-2.5 text-xs text-zinc-300 hover:bg-zinc-800" onClick={() => void pickKey()}>浏览</button>
            </div>
          </>
        )}

        {error && <p className="mb-3 text-xs text-red-400" role="alert">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" onClick={onClose}>取消</button>
          <button type="button" disabled={busy} className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50" onClick={() => void submit()}>
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </div>
    </div>
  );
}
