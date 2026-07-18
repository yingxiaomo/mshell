import { useState } from "react";
import type { HostKeyPrompt } from "../../types/protocol";
import { hostKeyTrust, sessionOpen } from "../../lib/tauri";
import { estimateTerminalGeometry } from "../../lib/terminalGeometry";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";

export interface HostKeyDialogProps {
  prompt: HostKeyPrompt | null;
  onClose: () => void;
}

export function HostKeyDialog({ prompt, onClose }: HostKeyDialogProps) {
  const addTab = useSessionsStore((s) => s.addTab);
  const setOpening = useSessionsStore((s) => s.setOpening);
  const setOpenError = useSessionsStore((s) => s.setOpenError);
  const switchToFilesOnOpen = useSettingsStore(
    (s) => s.settings.switchToFilesOnOpen,
  );
  const setActiveView = useUiStore((s) => s.setActiveView);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!prompt) return null;

  const isChanged = prompt.kind === "hostKeyChanged";
  const title = isChanged ? "主机密钥已变更" : "未知主机密钥";
  const warning = isChanged
    ? "服务器出示的密钥与本地 known_hosts 中保存的不一致。这可能表示中间人攻击，也可能是管理员轮换了主机密钥。请在确认指纹无误后再信任。"
    : "这是首次连接该主机（严格模式）。请核对手指纹后信任，随后将自动重试连接。";

  async function handleTrust() {
    if (!prompt) return;
    setBusy(true);
    setError(null);
    setOpening(true);
    setOpenError(null);
    try {
      await hostKeyTrust(prompt.host, prompt.fingerprint);
      const { cols, rows } = estimateTerminalGeometry();
      const result = await sessionOpen(prompt.connectionId, cols, rows);
      addTab(result);
      if (switchToFilesOnOpen) {
        setActiveView("files");
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setOpenError(msg);
    } finally {
      setBusy(false);
      setOpening(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="host-key-dialog-title"
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
      >
        <h2
          id="host-key-dialog-title"
          className="mb-2 text-lg font-semibold text-zinc-100"
        >
          {title}
        </h2>
        {prompt.connectionName && (
          <p className="mb-2 text-sm text-zinc-400">
            连接：
            <span className="text-zinc-200">{prompt.connectionName}</span>
          </p>
        )}
        <p className="mb-3 text-sm leading-relaxed text-zinc-400">{warning}</p>
        <dl className="mb-4 space-y-2 rounded border border-zinc-800 bg-zinc-950/80 p-3 text-xs">
          <div>
            <dt className="text-zinc-500">主机</dt>
            <dd className="break-all font-mono text-zinc-200">{prompt.host}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">指纹 (SHA256)</dt>
            <dd className="break-all font-mono text-amber-200/90">
              {prompt.fingerprint}
            </dd>
          </div>
        </dl>
        {error && (
          <p className="mb-3 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleTrust()}
            className={
              isChanged
                ? "rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                : "rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            }
          >
            {busy ? "处理中…" : isChanged ? "仍要信任并连接" : "信任并连接"}
          </button>
        </div>
      </div>
    </div>
  );
}
