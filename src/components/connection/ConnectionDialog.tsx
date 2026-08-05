import { useState, useEffect } from "react";
import type { AuthMethod, Connection, ConnectionProtocol, TunnelConfig, TunnelType } from "../../types/protocol";
import { useConnectionsStore } from "../../stores/connections";
import { useForm } from "../../lib/hooks/useForm";
import { inputClass, Field } from "./FormFields";
import { SerialConfigForm } from "./SerialConfigForm";
import { TunnelConfigSection, type TunnelDraft } from "./TunnelConfigSection";

type AuthType = "password" | "privateKey" | "agent" | "certificate";

export interface ConnectionDialogProps {
  open: boolean;
  initial?: Connection | null;
  onClose: () => void;
}

// ── 表单值类型 ─────────────────────────────────────────────────

interface FormValues {
  name: string;
  host: string;
  port: number;
  username: string;
  group: string;
  jumpHost: string;
  onConnect: string;
  password: string;
  keyPath: string;
  certPath: string;
  passphrase: string;
  serialPort: string;
  serialBaud: number;
  serialDataBits: number;
  serialStopBits: string;
  serialParity: string;
  serialFlowControl: string;
  color: string;
}

// ── 辅助函数 ───────────────────────────────────────────────────

function emptyAuth(type: AuthType): AuthMethod {
  switch (type) {
    case "password":
      return { type: "password", credentialId: "" };
    case "privateKey":
      return { type: "privateKey", path: "", passphraseCredentialId: null };
    case "certificate":
      return { type: "certificate", keyPath: "", certPath: "", passphraseCredentialId: null };
    case "agent":
      return { type: "agent" };
  }
}

function draftFromConfig(t: TunnelConfig): TunnelDraft {
  const base = { id: t.id, name: t.name, autoStart: t.autoStart, localHost: "127.0.0.1", localPort: 18080, remoteHost: "127.0.0.1", remotePort: 80 };
  if (t.kind.type === "local") return { ...base, kindType: "local" as const, localHost: t.kind.localHost, localPort: t.kind.localPort, remoteHost: t.kind.remoteHost, remotePort: t.kind.remotePort };
  if (t.kind.type === "remote") return { ...base, kindType: "remote" as const, localHost: t.kind.localHost, localPort: t.kind.localPort, remoteHost: t.kind.remoteHost, remotePort: t.kind.remotePort };
  return { ...base, kindType: "dynamic" as const, localHost: t.kind.localHost, localPort: t.kind.localPort };
}

function draftToConfig(d: TunnelDraft): TunnelConfig {
  let kind: TunnelType;
  if (d.kindType === "local") kind = { type: "local", localHost: d.localHost || "127.0.0.1", localPort: Number(d.localPort) || 0, remoteHost: d.remoteHost || "127.0.0.1", remotePort: Number(d.remotePort) || 0 };
  else if (d.kindType === "remote") kind = { type: "remote", remoteHost: d.remoteHost || "0.0.0.0", remotePort: Number(d.remotePort) || 0, localHost: d.localHost || "127.0.0.1", localPort: Number(d.localPort) || 0 };
  else kind = { type: "dynamic", localHost: d.localHost || "127.0.0.1", localPort: Number(d.localPort) || 0 };
  return { id: d.id, name: d.name.trim() || kindLabel(kind), kind, autoStart: d.autoStart };
}

function kindLabel(kind: TunnelType): string {
  switch (kind.type) {
    case "local": return `本地 ${kind.localPort}→${kind.remoteHost}:${kind.remotePort}`;
    case "remote": return `远程 ${kind.remotePort}→${kind.localHost}:${kind.localPort}`;
    case "dynamic": return `动态 SOCKS ${kind.localPort}`;
  }
}

function buildInitial(conn?: Connection | null): FormValues {
  return {
    name: conn?.name ?? "",
    host: conn?.host ?? "",
    port: conn?.port ?? 22,
    username: conn?.username ?? "",
    group: conn?.group ?? "",
    jumpHost: conn?.jumpHost ?? "",
    onConnect: conn?.onConnect ?? "",
    password: "",
    keyPath: conn?.auth.type === "privateKey" ? conn.auth.path : conn?.auth.type === "certificate" ? conn.auth.keyPath : "",
    certPath: conn?.auth.type === "certificate" ? conn.auth.certPath : "",
    passphrase: "",
    serialPort: conn?.serialConfig?.portName ?? "COM1",
    serialBaud: conn?.serialConfig?.baudRate ?? 9600,
    serialDataBits: conn?.serialConfig?.dataBits ?? 8,
    serialStopBits: conn?.serialConfig?.stopBits ?? "1",
    serialParity: conn?.serialConfig?.parity ?? "none",
    serialFlowControl: conn?.serialConfig?.flowControl ?? "none",
    color: conn?.color ?? "",
  };
}

export function ConnectionDialog({ open, initial, onClose }: ConnectionDialogProps) {
  const save = useConnectionsStore((s) => s.save);
  const allConnections = useConnectionsStore((s) => s.items);
  const form = useForm<FormValues>(buildInitial(initial));
  const { values, set, field, numberField } = form;

  const [protocol, setProtocol] = useState<ConnectionProtocol>("ssh");
  const [authType, setAuthType] = useState<AuthType>("password");
  const [tunnels, setTunnels] = useState<TunnelDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jumpCandidates = allConnections.filter((c) => c.id !== initial?.id && c.source?.type !== "sshConfig");
  const existingGroups = [...new Set(allConnections.map((c) => c.group).filter((g): g is string => !!g))].sort();

  // Reset form on open/initial change
  useEffect(() => {
    if (!open) return;
    const init = buildInitial(initial);
    // form.reset() would revert to the first initial, so we set explicitly
    set(init);
    setProtocol(initial?.protocol ?? "ssh");
    setAuthType(initial?.auth.type ?? "password");
    setTunnels((initial?.tunnels ?? []).map(draftFromConfig));
    setError(null);
    setSaving(false);
  }, [open, initial, set]);

  if (!open) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!values.name.trim()) { setError("名称不能为空"); return; }
    if (protocol === "serial") { if (!values.serialPort.trim()) { setError("请选择串口号"); return; } }
    else if (protocol === "telnet") { if (!values.host.trim()) { setError("主机不能为空"); return; } }
    else if (protocol !== "local" && (!values.host.trim() || !values.username.trim())) { setError("名称、主机和用户名不能为空"); return; }

    let auth = emptyAuth(authType);
    if (authType === "privateKey") {
      auth = { type: "privateKey", path: values.keyPath, passphraseCredentialId: initial?.auth.type === "privateKey" ? initial.auth.passphraseCredentialId : null };
    } else if (authType === "certificate") {
      auth = { type: "certificate", keyPath: values.keyPath, certPath: values.certPath, passphraseCredentialId: initial?.auth.type === "certificate" ? initial.auth.passphraseCredentialId : null };
    } else if (authType === "password" && initial?.auth.type === "password") {
      auth = { type: "password", credentialId: initial.auth.credentialId };
    }

    const conn: Connection = {
      id: initial?.id ?? crypto.randomUUID(),
      name: values.name.trim(),
      host: protocol === "serial" ? values.serialPort.trim() : protocol === "local" ? "localhost" : values.host.trim(),
      port: protocol === "serial" || protocol === "local" ? 0 : Number(values.port) || (protocol === "telnet" ? 23 : 22),
      protocol,
      username: protocol === "ssh" ? values.username.trim() : "",
      auth: protocol === "ssh" ? auth : { type: "password", credentialId: "" },
      group: values.group.trim() || null,
      tags: initial?.tags ?? [],
      jumpHost: protocol === "ssh" ? (values.jumpHost || null) : null,
      tunnels: protocol === "ssh" ? tunnels.map(draftToConfig) : [],
      source: initial?.source ?? { type: "manual" },
      lastConnected: initial?.lastConnected ?? null,
      notes: initial?.notes ?? null,
      serialConfig: protocol === "serial" ? { portName: values.serialPort, baudRate: values.serialBaud, dataBits: values.serialDataBits, stopBits: values.serialStopBits, parity: values.serialParity, flowControl: values.serialFlowControl } : (initial?.serialConfig ?? null),
      onConnect: values.onConnect.trim() || null,
      color: values.color.trim() || null,
    };

    setSaving(true);
    try {
      await save(conn, values.password.trim() ? values.password : undefined, values.passphrase.trim() ? values.passphrase : undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const serialConfig = { portName: values.serialPort, baudRate: values.serialBaud, dataBits: values.serialDataBits, stopBits: values.serialStopBits, parity: values.serialParity, flowControl: values.serialFlowControl };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form onSubmit={onSubmit} className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold text-zinc-100">{initial ? "编辑连接" : "新建连接"}</h2>

        <div className="space-y-3">
          <Field label="名称"><input className={inputClass} {...field("name")} autoFocus /></Field>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Field label="协议">
                <select className={inputClass} value={protocol} onChange={(e) => setProtocol(e.target.value as ConnectionProtocol)}>
                  <option value="ssh">SSH</option>
                  <option value="telnet">Telnet</option>
                  <option value="local">本地终端</option>
                  <option value="serial">串口</option>
                </select>
                <p className="mt-1 text-xs text-zinc-600">
                  {protocol === "telnet" ? "Telnet 为明文协议，不含认证、SFTP 与隧道功能。" : protocol === "local" ? "启动本地 cmd.exe / PowerShell，无需网络连接。" : protocol === "serial" ? "通过 COM 口连接网络设备 console。需配置端口号与波特率。" : ""}
                </p>
              </Field>
              {protocol === "serial" && <SerialConfigForm config={serialConfig} onChange={(c) => set({ serialPort: c.portName, serialBaud: c.baudRate, serialDataBits: c.dataBits, serialStopBits: c.stopBits, serialParity: c.parity, serialFlowControl: c.flowControl ?? "none" })} />}
              {protocol !== "serial" && protocol !== "local" && <Field label="主机"><input className={inputClass} {...field("host")} placeholder="example.com" /></Field>}
            </div>
            {protocol !== "serial" && protocol !== "local" && <Field label="端口"><input className={inputClass} type="number" min={1} max={65535} {...numberField("port")} /></Field>}
          </div>

          {protocol !== "telnet" && protocol !== "local" && protocol !== "serial" && (<>
            <Field label="用户名"><input className={inputClass} {...field("username")} /></Field>
            <Field label="分组">
              <div className="flex gap-1">
                <select className={inputClass} value={values.group} onChange={(e) => set({ group: e.target.value })}>
                  <option value="">无</option>
                  {existingGroups.map((g) => (<option key={g} value={g}>{g}</option>))}
                  {values.group && !existingGroups.includes(values.group) && <option value={values.group}>{values.group}（新建）</option>}
                </select>
                {values.group && (
                  <button type="button" className="shrink-0 rounded px-2 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onClick={() => set({ group: "" })} title="清除分组">✕</button>
                )}
              </div>
            </Field>

            <Field label="颜色标记">
              <div className="flex items-center gap-2">
                <input type="color" className="h-8 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-900" value={values.color || "#38bdf8"} onChange={(e) => set({ color: e.target.value })} />
                {values.color && <button type="button" className="rounded px-2 text-xs text-zinc-500 hover:text-red-400" onClick={() => set({ color: "" })}>清除</button>}
              </div>
            </Field>

            <Field label="跳板机 ProxyJump（可选）">
              <select className={inputClass} value={values.jumpHost} onChange={(e) => set({ jumpHost: e.target.value })}>
                <option value="">无</option>
                {jumpCandidates.map((c) => (<option key={c.id} value={c.id}>{c.name} ({c.username}@{c.host}:{c.port})</option>))}
              </select>
            </Field>

            <Field label="连接后自动执行（可选）">
              <input className={inputClass} placeholder="例如 cd /var/www && ls" {...field("onConnect")} />
            </Field>

            <Field label="认证方式">
              <select className={inputClass} value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
                <option value="password">密码</option>
                <option value="privateKey">私钥</option>
                <option value="agent">SSH Agent</option>
                <option value="certificate">证书</option>
              </select>
            </Field>

            {authType === "password" && (
              <Field label={initial?.auth.type === "password" && initial.auth.credentialId ? "密码（留空则保留已存凭据）" : "密码"}>
                <input className={inputClass} type="password" {...field("password")} autoComplete="new-password" />
              </Field>
            )}

            {authType === "privateKey" && (<>
              <Field label="私钥路径"><input className={inputClass} {...field("keyPath")} placeholder="~/.ssh/id_ed25519" /></Field>
              <Field label="私钥口令（可选）"><input className={inputClass} type="password" {...field("passphrase")} autoComplete="new-password" /></Field>
            </>)}

            {authType === "certificate" && (<>
              <Field label="密钥路径"><input className={inputClass} {...field("keyPath")} /></Field>
              <Field label="证书路径"><input className={inputClass} {...field("certPath")} /></Field>
              <Field label="口令（可选）"><input className={inputClass} type="password" {...field("passphrase")} autoComplete="new-password" /></Field>
            </>)}

            <TunnelConfigSection tunnels={tunnels} onChange={setTunnels} />
          </>)}
        </div>

        {error && <p className="mt-3 text-sm text-red-400" role="alert">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800" disabled={saving}>取消</button>
          <button type="submit" disabled={saving} className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">{saving ? "保存中…" : "保存"}</button>
        </div>
      </form>
    </div>
  );
}
