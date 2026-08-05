import { useState, useEffect } from "react";
import type { SerialConfig } from "../../types/protocol";
import { cmd, commands } from "../../lib/commands";
import { inputClass, Field } from "./FormFields";

export interface SerialConfigFormProps {
  config: SerialConfig;
  onChange: (config: SerialConfig) => void;
}

export function SerialConfigForm({ config, onChange }: SerialConfigFormProps) {
  const [serialPorts, setSerialPorts] = useState<string[]>([]);
  const [serialPortsLoading, setSerialPortsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSerialPortsLoading(true);
    void cmd(commands.listSerialPorts).then((ports) => {
        if (cancelled) return;
        setSerialPorts(ports);
        if (ports.length > 0 && !ports.includes(config.portName)) {
          onChange({ ...config, portName: ports[0]! });
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
  }, []);

  const set = (patch: Partial<SerialConfig>) =>
    onChange({ ...config, ...patch });

  return (
    <div className="space-y-3 col-span-3">
      <Field label="串口号">
        <div className="flex gap-2">
          <select
            className={inputClass}
            value={config.portName}
            onChange={(e) => set({ portName: e.target.value })}
          >
            {serialPorts.length === 0 && (
              <option value={config.portName}>{config.portName || "COM1"}</option>
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
              void cmd(commands.listSerialPorts)
                .then((ports) => {
                  setSerialPorts(ports);
                  if (ports.length && !ports.includes(config.portName))
                    set({ portName: ports[0]! });
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
          <input
            className={inputClass}
            value={config.portName}
            onChange={(e) => set({ portName: e.target.value })}
            placeholder="COM1"
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="波特率">
          <input
            list="serial-baud-presets"
            className={inputClass}
            type="number"
            value={config.baudRate}
            onChange={(e) => set({ baudRate: Number(e.target.value) || 9600 })}
          />
          <datalist id="serial-baud-presets">
            <option value={9600} />
            <option value={19200} />
            <option value={38400} />
            <option value={57600} />
            <option value={115200} />
            <option value={230400} />
            <option value={250000} />
            <option value={460800} />
            <option value={921600} />
            <option value={1000000} />
            <option value={2000000} />
          </datalist>
        </Field>
        <Field label="数据位">
          <select
            className={inputClass}
            value={config.dataBits}
            onChange={(e) => set({ dataBits: Number(e.target.value) })}
          >
            <option value={7}>7</option>
            <option value={8}>8</option>
          </select>
        </Field>
        <Field label="停止位">
          <select
            className={inputClass}
            value={config.stopBits}
            onChange={(e) => set({ stopBits: e.target.value })}
          >
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </Field>
        <Field label="校验">
          <select
            className={inputClass}
            value={config.parity}
            onChange={(e) => set({ parity: e.target.value })}
          >
            <option value="none">无</option>
            <option value="odd">奇校验</option>
            <option value="even">偶校验</option>
          </select>
        </Field>
        <Field label="流控">
          <select
            className={inputClass}
            value={config.flowControl ?? "none"}
            onChange={(e) => set({ flowControl: e.target.value })}
          >
            <option value="none">无</option>
            <option value="hardware">硬件 (RTS/CTS)</option>
            <option value="software">软件 (XON/XOFF)</option>
          </select>
        </Field>
      </div>
    </div>
  );
}
