import { useEffect, useState } from "react";
import type {
  AuthMethod,
  Connection,
  ConnectionProtocol,
  TunnelConfig,
  TunnelType,
} from "../../types/protocol";
import { useConnectionsStore } from "../../stores/connections";
import { listSerialPorts } from "../../lib/tauri";

type AuthType = "password" | "privateKey" | "agent" | "certificate";
type TunnelKindType = "local" | "remote" | "dynamic";

export interface ConnectionDialogProps {
  open: boolean;
  initial?: Connection | null;
  onClose: () => void;
}

function emptyAuth(type: AuthType): AuthMethod {
  switch (type) {
    case "password":
      return { type: "password", credentialId: "" };
    case "privateKey":
      return { type: "privateKey", path: "", passphraseCredentialId: null };
    case "certificate":
      return {
        type: "certificate",
        keyPath: "",
        certPath: "",
        passphraseCredentialId: null,
      };
    case "agent":
      return { type: "agent" };
  }
}

type DraftTunnel = {
  id: string;
  name: string;
  kindType: TunnelKindType;
  autoStart: boolean;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
};

function draftFromConfig(t: TunnelConfig): DraftTunnel {
  const base = {
    id: t.id,
    name: t.name,
    autoStart: t.autoStart,
    localHost: "127.0.0.1",
    localPort: 18080,
    remoteHost: "127.0.0.1",
    remotePort: 80,
  };
  if (t.kind.type === "local") {
    return {
      ...base,
      kindType: "local",
      localHost: t.kind.localHost,
      localPort: t.kind.localPort,
      remoteHost: t.kind.remoteHost,
      remotePort: t.kind.remotePort,
    };
  }
  if (t.kind.type === "remote") {
    return {
      ...base,
      kindType: "remote",
      localHost: t.kind.localHost,
      localPort: t.kind.localPort,
      remoteHost: t.kind.remoteHost,
      remotePort: t.kind.remotePort,
    };
  }
  return {
    ...base,
    kindType: "dynamic",
    localHost: t.kind.localHost,
    localPort: t.kind.localPort,
  };
}

function draftToConfig(d: DraftTunnel): TunnelConfig {
  let kind: TunnelType;
  if (d.kindType === "local") {
    kind = {
      type: "local",
      localHost: d.localHost || "127.0.0.1",
      localPort: Number(d.localPort) || 0,
      remoteHost: d.remoteHost || "127.0.0.1",
      remotePort: Number(d.remotePort) || 0,
    };
  } else if (d.kindType === "remote") {
    kind = {
      type: "remote",
      remoteHost: d.remoteHost || "0.0.0.0",
      remotePort: Number(d.remotePort) || 0,
      localHost: d.localHost || "127.0.0.1",
      localPort: Number(d.localPort) || 0,
    };
  } else {
    kind = {
      type: "dynamic",
      localHost: d.localHost || "127.0.0.1",
      localPort: Number(d.localPort) || 0,
    };
  }
  return {
    id: d.id,
    name: d.name.trim() || kindLabel(kind),
    kind,
    autoStart: d.autoStart,
  };
}

function kindLabel(kind: TunnelType): string {
  switch (kind.type) {
    case "local":
      return `本地 ${kind.localPort}→${kind.remoteHost}:${kind.remotePort}`;
    case "remote":
      return `远程 ${kind.remotePort}→${kind.localHost}:${kind.localPort}`;
    case "dynamic":
      return `动态 SOCKS ${kind.localPort}`;
  }
}

function emptyDraft(): DraftTunnel {
  return {
    id: crypto.randomUUID(),
    name: "",
    kindType: "local",
    autoStart: true,
    localHost: "127.0.0.1",
    localPort: 18080,
    remoteHost: "127.0.0.1",
    remotePort: 80,
  };
}

export function ConnectionDialog({
  open,
  initial,
  onClose,
}: ConnectionDialogProps) {
  const save = useConnectionsStore((s) => s.save);
  const allConnections = useConnectionsStore((s) => s.items);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [protocol, setProtocol] = useState<ConnectionProtocol>("ssh");
  const [username, setUsername] = useState("");
  const [group, setGroup] = useState("");
  const [jumpHost, setJumpHost] = useState<string>("");
  const [authType, setAuthType] = useState<AuthType>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [certPath, setCertPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [tunnels, setTunnels] = useState<DraftTunnel[]>([]);
  const [serialPort, setSerialPort] = useState("COM1");
  const [serialBaud, setSerialBaud] = useState(9600);
  const [serialDataBits, setSerialDataBits] = useState(8);
  const [serialStopBits, setSerialStopBits] = useState("1");
  const [serialParity, setSerialParity] = useState("none");
  const [serialPorts, setSerialPorts] = useState<string[]>([]);
  const [serialPortsLoading, setSerialPortsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jumpCandidates = allConnections.filter(
    (c) => c.id !== initial?.id && c.source?.type !== "sshConfig",
  );

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setHost(initial.host);
      setPort(initial.port);
      setProtocol(initial.protocol ?? "ssh");
      setUsername(initial.username);
      setGroup(initial.group ?? "");
      setJumpHost(initial.jumpHost ?? "");
      setAuthType(initial.auth.type);
      setPassword("");
      setPassphrase("");
      setTunnels((initial.tunnels ?? []).map(draftFromConfig));
      setSerialPort(initial.serialConfig?.portName ?? "COM1");
      setSerialBaud(initial.serialConfig?.baudRate ?? 9600);
      setSerialDataBits(initial.serialConfig?.dataBits ?? 8);
      setSerialStopBits(initial.serialConfig?.stopBits ?? "1");
      setSerialParity(initial.serialConfig?.parity ?? "none");
      if (initial.auth.type === "privateKey") {
        setKeyPath(initial.auth.path);
        setCertPath("");
      } else if (initial.auth.type === "certificate") {
        setKeyPath(initial.auth.keyPath);
        setCertPath(initial.auth.certPath);
      } else {
        setKeyPath("");
        setCertPath("");
      }
    } else {
      setName("");
      setHost("");
      setPort(22);
      setUsername("");
      setGroup("");
      setJumpHost("");
      setAuthType("password");
      setPassword("");
      setKeyPath("");
      setCertPath("");
      setPassphrase("");
      setTunnels([]);
      setSerialPort("COM1");
      setSerialBaud(9600);
      setSerialDataBits(8);
      setSerialStopBits("1");
      setSerialParity("none");
    }
    setError(null);
    setSaving(false);
  }, [open, initial]);

  // Enumerate COM ports when dialog opens or protocol switches to serial.
  useEffect(() => {
    if (!open || protocol !== "serial") return;
    let cancelled = false;
    setSerialPortsLoading(true);
    void listSerialPorts()
      .then((ports) => {
        if (cancelled) return;
        setSerialPorts(ports);
        if (ports.length > 0 && !ports.includes(serialPort)) {
          setSerialPort(ports[0]!);
        }
      })
      .catch(() => {
        if (!cancelled) setSerialPorts([]);
      })
      .finally(() => {
        if (!cancelled) setSerialPortsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, protocol]);

  if (!open) return null;

  function updateTunnel(id: string, patch: Partial<DraftTunnel>) {
    setTunnels((list) =>
      list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("名称不能为空");
      return;
    }
    if (protocol === "serial") {
      if (!serialPort.trim()) {
        setError("请选择串口号");
        return;
      }
    } else if (protocol === "local") {
      // local terminal only needs a name
    } else if (protocol === "telnet") {
      if (!host.trim()) {
        setError("主机不能为空");
        return;
      }
    } else if (!host.trim() || !username.trim()) {
      setError("名称、主机和用户名不能为空");
      return;
    }

    let auth = emptyAuth(authType);
    if (authType === "privateKey") {
      auth = {
        type: "privateKey",
        path: keyPath,
        passphraseCredentialId:
          initial?.auth.type === "privateKey"
            ? initial.auth.passphraseCredentialId
            : null,
      };
    } else if (authType === "certificate") {
      auth = {
        type: "certificate",
        keyPath,
        certPath,
        passphraseCredentialId:
          initial?.auth.type === "certificate"
            ? initial.auth.passphraseCredentialId
            : null,
      };
    } else if (authType === "password" && initial?.auth.type === "password") {
      auth = {
        type: "password",
        credentialId: initial.auth.credentialId,
      };
    }

    const conn: Connection = {
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      host: protocol === "serial" ? serialPort.trim() : protocol === "local" ? "localhost" : host.trim(),
      port: protocol === "serial" || protocol === "local" ? 0 : Number(port) || (protocol === "telnet" ? 23 : 22),
      protocol: protocol,
      username: protocol === "ssh" ? username.trim() : "",
      auth: protocol === "ssh" ? auth : { type: "password", credentialId: "" },
      group: group.trim() || null,
      tags: initial?.tags ?? [],
      jumpHost: protocol === "ssh" ? (jumpHost || null) : null,
      tunnels: protocol === "ssh" ? tunnels.map(draftToConfig) : [],
      source: initial?.source ?? { type: "manual" },
      lastConnected: initial?.lastConnected ?? null,
      notes: initial?.notes ?? null,
      serialConfig: protocol === "serial" ? {
        portName: serialPort,
        baudRate: serialBaud,
        dataBits: serialDataBits,
        stopBits: serialStopBits,
        parity: serialParity,
      } : (initial?.serialConfig ?? null),
    };

    setSaving(true);
    try {
      await save(
        conn,
        password.trim() ? password : undefined,
        passphrase.trim() ? passphrase : undefined,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={onSubmit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-semibold text-zinc-100">
          {initial ? "编辑连接" : "新建连接"}
        </h2>

        <div className="space-y-3">
          <Field label="名称">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <Field label="协议">
              <select
                className={inputClass}
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as ConnectionProtocol)}
              >
                <option value="ssh">SSH</option>
                <option value="telnet">Telnet</option>
                <option value="local">本地终端</option>
                <option value="serial">串口</option>
              </select>
              <p className="text-xs text-zinc-600 mt-1">
                {protocol === "telnet"
                  ? "Telnet 为明文协议，不含认证、SFTP 与隧道功能。"
                  : protocol === "local"
                  ? "启动本地 cmd.exe / PowerShell，无需网络连接。"
                  : protocol === "serial"
                  ? "通过 COM 口连接网络设备 console。需配置端口号与波特率。"
                  : ""}
              </p>
            </Field>
            {protocol === "serial" && (
              <div className="space-y-3 col-span-3">
                <Field label="串口号">
                  <div className="flex gap-2">
                    <select
                      className={inputClass}
                      value={serialPort}
                      onChange={(e) => setSerialPort(e.target.value)}
                    >
                      {serialPorts.length === 0 && (
                        <option value={serialPort}>{serialPort || "COM1"}</option>
                      )}
                      {serialPorts.map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-zinc-700 px-2 text-xs text-zinc-300 hover:bg-zinc-800"
                      onClick={() => {
                        setSerialPortsLoading(true);
                        void listSerialPorts()
                          .then((ports) => {
                            setSerialPorts(ports);
                            if (ports.length && !ports.includes(serialPort)) setSerialPort(ports[0]!);
                          })
                          .finally(() => setSerialPortsLoading(false));
                      }}
                    >
                      {serialPortsLoading ? "…" : "刷新"}
                    </button>
                  </div>
                </Field>
                {serialPorts.length === 0 && (
                  <Field label="手动串口号">
                    <input className={inputClass} value={serialPort} onChange={(e) => setSerialPort(e.target.value)} placeholder="COM1" />
                  </Field>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Field label="波特率">
                    <select className={inputClass} value={serialBaud} onChange={(e) => setSerialBaud(Number(e.target.value))}>
                      <option value={9600}>9600</option>
                      <option value={19200}>19200</option>
                      <option value={38400}>38400</option>
                      <option value={57600}>57600</option>
                      <option value={115200}>115200</option>
                    </select>
                  </Field>
                  <Field label="数据位">
                    <select className={inputClass} value={serialDataBits} onChange={(e) => setSerialDataBits(Number(e.target.value))}>
                      <option value={7}>7</option>
                      <option value={8}>8</option>
                    </select>
                  </Field>
                  <Field label="停止位">
                    <select className={inputClass} value={serialStopBits} onChange={(e) => setSerialStopBits(e.target.value)}>
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </select>
                  </Field>
                  <Field label="校验">
                    <select className={inputClass} value={serialParity} onChange={(e) => setSerialParity(e.target.value)}>
                      <option value="none">无</option>
                      <option value="odd">奇校验</option>
                      <option value="even">偶校验</option>
                    </select>
                  </Field>
                </div>
              </div>
            )}
            {protocol !== "serial" && protocol !== "local" && (
              <Field label="主机">
                <input
                  className={inputClass}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="example.com"
                />
              </Field>
            )}
            </div>
            {protocol !== "serial" && protocol !== "local" && (
            <Field label="端口">
              <input
                className={inputClass}
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
              />
            </Field>
            )}
          </div>
          {protocol !== "telnet" && protocol !== "local" && protocol !== "serial" && (<><Field label="用户名">
            <input
              className={inputClass}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="分组（可选）">
            <input
              className={inputClass}
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            />
          </Field>
          <Field label="跳板机 ProxyJump（可选）">
            <select
              className={inputClass}
              value={jumpHost}
              onChange={(e) => setJumpHost(e.target.value)}
            >
              <option value="">无</option>
              {jumpCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.username}@{c.host}:{c.port})
                </option>
              ))}
            </select>
          </Field>
          <Field label="认证方式">
            <select
              className={inputClass}
              value={authType}
              onChange={(e) => setAuthType(e.target.value as AuthType)}
            >
              <option value="password">密码</option>
              <option value="privateKey">私钥</option>
              <option value="agent">SSH Agent</option>
              <option value="certificate">证书</option>
            </select>
          </Field>

          {authType === "password" && (
            <Field
              label={
                initial?.auth.type === "password" && initial.auth.credentialId
                  ? "密码（留空则保留已存凭据）"
                  : "密码"
              }
            >
              <input
                className={inputClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          )}

          {authType === "privateKey" && (
            <>
              <Field label="私钥路径">
                <input
                  className={inputClass}
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
              </Field>
              <Field label="私钥口令（可选）">
                <input
                  className={inputClass}
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          {authType === "certificate" && (
            <>
              <Field label="密钥路径">
                <input
                  className={inputClass}
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                />
              </Field>
              <Field label="证书路径">
                <input
                  className={inputClass}
                  value={certPath}
                  onChange={(e) => setCertPath(e.target.value)}
                />
              </Field>
              <Field label="口令（可选）">
                <input
                  className={inputClass}
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}

          <div className="border-t border-zinc-800 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-300">
                端口转发 / 隧道
              </span>
              <button
                type="button"
                onClick={() => setTunnels((t) => [...t, emptyDraft()])}
                className="rounded-md px-2 py-1 text-xs text-sky-400 hover:bg-zinc-800"
              >
                + 添加
              </button>
            </div>
            {tunnels.length === 0 ? (
              <p className="text-[11px] text-zinc-500">
                可选。本地 / 动态为完整支持；远程为尽力支持。勾选自动启动将在会话打开时启动。
              </p>
            ) : (
              <ul className="space-y-2">
                {tunnels.map((t) => (
                  <li
                    key={t.id}
                    className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <input
                        className={`${inputClass} flex-1`}
                        placeholder="名称"
                        value={t.name}
                        onChange={(e) =>
                          updateTunnel(t.id, { name: e.target.value })
                        }
                      />
                      <select
                        className={inputClass}
                        value={t.kindType}
                        onChange={(e) =>
                          updateTunnel(t.id, {
                            kindType: e.target.value as TunnelKindType,
                          })
                        }
                      >
                        <option value="local">本地</option>
                        <option value="dynamic">动态 SOCKS5</option>
                        <option value="remote">远程</option>
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          setTunnels((list) =>
                            list.filter((x) => x.id !== t.id),
                          )
                        }
                        className="shrink-0 rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                        aria-label="删除隧道"
                      >
                        ×
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {(t.kindType === "local" ||
                        t.kindType === "dynamic" ||
                        t.kindType === "remote") && (
                        <>
                          <Field label="本地主机">
                            <input
                              className={inputClass}
                              value={t.localHost}
                              onChange={(e) =>
                                updateTunnel(t.id, {
                                  localHost: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label="本地端口">
                            <input
                              className={inputClass}
                              type="number"
                              min={1}
                              max={65535}
                              value={t.localPort}
                              onChange={(e) =>
                                updateTunnel(t.id, {
                                  localPort: Number(e.target.value),
                                })
                              }
                            />
                          </Field>
                        </>
                      )}
                      {(t.kindType === "local" || t.kindType === "remote") && (
                        <>
                          <Field
                            label={
                              t.kindType === "remote"
                                ? "远程绑定主机"
                                : "远程目标主机"
                            }
                          >
                            <input
                              className={inputClass}
                              value={t.remoteHost}
                              onChange={(e) =>
                                updateTunnel(t.id, {
                                  remoteHost: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field
                            label={
                              t.kindType === "remote"
                                ? "远程绑定端口"
                                : "远程目标端口"
                            }
                          >
                            <input
                              className={inputClass}
                              type="number"
                              min={1}
                              max={65535}
                              value={t.remotePort}
                              onChange={(e) =>
                                updateTunnel(t.id, {
                                  remotePort: Number(e.target.value),
                                })
                              }
                            />
                          </Field>
                        </>
                      )}
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
                      <input
                        type="checkbox"
                        checked={t.autoStart}
                        onChange={(e) =>
                          updateTunnel(t.id, { autoStart: e.target.checked })
                        }
                      />
                      会话打开时自动启动
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          </>)}
          </div>

        {error && (
          <p className="mt-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            disabled={saving}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs text-zinc-400">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}
