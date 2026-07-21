import type { Connection } from "../../types/protocol";

export interface SessionListItemProps {
  connection: Connection;
  onEdit: (c: Connection) => void;
  onDelete: (id: string) => void;
  onOpen: (c: Connection) => void;
  onDuplicateAsLocal?: (c: Connection) => void;
}

function isImported(c: Connection): boolean {
  return c.source?.type === "sshConfig";
}

function protocolLabel(c: Connection): string | null {
  switch (c.protocol) {
    case "telnet":
      return "telnet";
    case "local":
      return "local";
    case "serial":
      return "serial";
    default:
      return null;
  }
}

function subtitleFor(c: Connection): string {
  switch (c.protocol) {
    case "telnet":
      return `${c.host}:${c.port || 23}`;
    case "local":
      return "本机 shell";
    case "serial": {
      const sc = c.serialConfig;
      if (sc) return `${sc.portName} · ${sc.baudRate}`;
      return c.host || "COM?";
    }
    default:
      return `${c.username}@${c.host}:${c.port}`;
  }
}

const GROUP_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#84cc16", "#f97316", "#ec4899", "#6366f1",
];

function groupColor(group: string | null | undefined): string | undefined {
  if (!group) return undefined;
  let hash = 0;
  for (let i = 0; i < group.length; i++) hash = ((hash << 5) - hash) + group.charCodeAt(i);
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}
export function SessionListItem({
  connection,
  onEdit,
  onDelete,
  onOpen,
  onDuplicateAsLocal,
}: SessionListItemProps) {
  const imported = isImported(connection);
  const subtitle = subtitleFor(connection);
  const proto = protocolLabel(connection);
  const color = imported ? undefined : groupColor(connection.group);
  return (
    <li
      className="group flex cursor-pointer items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 hover:border-zinc-700 hover:bg-zinc-800/50"
      style={color ? { borderLeftColor: color, borderLeftWidth: 3 } : undefined}
      onDoubleClick={() => {
        if (!imported) onOpen(connection);
      }}
      title={imported ? "导入项只读；请「复制为本地」后连接" : "双击打开会话"}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">
            {connection.name}
          </span>
          {proto && (
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              {proto}
            </span>
          )}
          {imported && (
            <span
              className="shrink-0 rounded bg-amber-900/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300"
              title={
                connection.source.type === "sshConfig"
                  ? connection.source.path
                  : "ssh config"
              }
            >
              ssh config
            </span>
          )}
        </div>
        <div className="truncate text-xs text-zinc-500">{subtitle}</div>
      </div>
      <div className="flex shrink-0 gap-1 opacity-80 group-hover:opacity-100">
        {imported ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicateAsLocal?.(connection);
            }}
            className="rounded px-2 py-1 text-xs text-sky-400 hover:bg-zinc-800"
          >
            复制为本地
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(connection);
              }}
              className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              编辑
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(connection.id);
              }}
              className="rounded px-2 py-1 text-xs text-red-400 hover:bg-zinc-800"
            >
              删除
            </button>
          </>
        )}
      </div>
    </li>
  );
}
