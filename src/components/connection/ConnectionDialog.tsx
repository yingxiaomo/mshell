import { useEffect, useState } from "react";
import type { AuthMethod, Connection } from "../../types/protocol";
import { useConnectionsStore } from "../../stores/connections";

type AuthType = "password" | "privateKey" | "agent" | "certificate";

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

export function ConnectionDialog({
  open,
  initial,
  onClose,
}: ConnectionDialogProps) {
  const save = useConnectionsStore((s) => s.save);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [group, setGroup] = useState("");
  const [authType, setAuthType] = useState<AuthType>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [certPath, setCertPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setHost(initial.host);
      setPort(initial.port);
      setUsername(initial.username);
      setGroup(initial.group ?? "");
      setAuthType(initial.auth.type);
      setPassword("");
      setPassphrase("");
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
      setAuthType("password");
      setPassword("");
      setKeyPath("");
      setCertPath("");
      setPassphrase("");
    }
    setError(null);
    setSaving(false);
  }, [open, initial]);

  if (!open) return null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !host.trim() || !username.trim()) {
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
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      auth,
      group: group.trim() || null,
      tags: initial?.tags ?? [],
      jumpHost: initial?.jumpHost ?? null,
      tunnels: initial?.tunnels ?? [],
      source: initial?.source ?? { type: "manual" },
      lastConnected: initial?.lastConnected ?? null,
      notes: initial?.notes ?? null,
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
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
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
              <Field label="主机">
                <input
                  className={inputClass}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="example.com"
                />
              </Field>
            </div>
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
          </div>
          <Field label="用户名">
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
