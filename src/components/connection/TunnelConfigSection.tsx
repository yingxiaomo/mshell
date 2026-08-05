/**
 * Tunnel editor section for the connection dialog.
 * Supports local / remote / dynamic (SOCKS5) tunnel types.
 */

import { Field, inputClass } from "./FormFields";

export type TunnelKindType = "local" | "remote" | "dynamic";

export interface TunnelDraft {
  id: string;
  name: string;
  kindType: TunnelKindType;
  autoStart: boolean;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface TunnelConfigSectionProps {
  tunnels: TunnelDraft[];
  onChange: (tunnels: TunnelDraft[]) => void;
}

export function TunnelConfigSection({ tunnels, onChange }: TunnelConfigSectionProps) {
  const addEmpty = () => {
    onChange([
      ...tunnels,
      {
        id: crypto.randomUUID(),
        name: "",
        kindType: "local",
        autoStart: true,
        localHost: "127.0.0.1",
        localPort: 18080,
        remoteHost: "127.0.0.1",
        remotePort: 80,
      },
    ]);
  };

  const remove = (id: string) => {
    onChange(tunnels.filter((t) => t.id !== id));
  };

  const update = (id: string, patch: Partial<TunnelDraft>) => {
    onChange(tunnels.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  return (
    <div className="border-t border-zinc-800 pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">
          端口转发 / 隧道
        </span>
        <button
          type="button"
          onClick={addEmpty}
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
                  onChange={(e) => update(t.id, { name: e.target.value })}
                />
                <select
                  className={inputClass}
                  value={t.kindType}
                  onChange={(e) =>
                    update(t.id, { kindType: e.target.value as TunnelKindType })
                  }
                >
                  <option value="local">本地</option>
                  <option value="dynamic">动态 SOCKS5</option>
                  <option value="remote">远程</option>
                </select>
                <button
                  type="button"
                  onClick={() => remove(t.id)}
                  className="shrink-0 rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                  aria-label="删除隧道"
                >
                  ×
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(t.kindType === "local" || t.kindType === "dynamic" || t.kindType === "remote") && (
                  <>
                    <Field label="本地主机">
                      <input
                        className={inputClass}
                        value={t.localHost}
                        onChange={(e) => update(t.id, { localHost: e.target.value })}
                      />
                    </Field>
                    <Field label="本地端口">
                      <input
                        className={inputClass}
                        type="number"
                        min={1}
                        max={65535}
                        value={t.localPort}
                        onChange={(e) => update(t.id, { localPort: Number(e.target.value) })}
                      />
                    </Field>
                  </>
                )}
                {(t.kindType === "local" || t.kindType === "remote") && (
                  <>
                    <Field
                      label={t.kindType === "remote" ? "远程绑定主机" : "远程目标主机"}
                    >
                      <input
                        className={inputClass}
                        value={t.remoteHost}
                        onChange={(e) => update(t.id, { remoteHost: e.target.value })}
                      />
                    </Field>
                    <Field
                      label={t.kindType === "remote" ? "远程绑定端口" : "远程目标端口"}
                    >
                      <input
                        className={inputClass}
                        type="number"
                        min={1}
                        max={65535}
                        value={t.remotePort}
                        onChange={(e) => update(t.id, { remotePort: Number(e.target.value) })}
                      />
                    </Field>
                  </>
                )}
              </div>
              <label className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={t.autoStart}
                  onChange={(e) => update(t.id, { autoStart: e.target.checked })}
                />
                会话打开时自动启动
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
