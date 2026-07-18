import type { Connection } from "../../types/protocol";

export interface SessionListItemProps {
  connection: Connection;
  onEdit: (c: Connection) => void;
  onDelete: (id: string) => void;
}

export function SessionListItem({
  connection,
  onEdit,
  onDelete,
}: SessionListItemProps) {
  const subtitle = `${connection.username}@${connection.host}:${connection.port}`;
  return (
    <li className="group flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 hover:border-zinc-700">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-100">
          {connection.name}
        </div>
        <div className="truncate text-xs text-zinc-500">{subtitle}</div>
        {connection.group && (
          <div className="mt-0.5 text-[11px] text-zinc-600">
            {connection.group}
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-1 opacity-80 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onEdit(connection)}
          className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          编辑
        </button>
        <button
          type="button"
          onClick={() => onDelete(connection.id)}
          className="rounded px-2 py-1 text-xs text-red-400 hover:bg-zinc-800"
        >
          删除
        </button>
      </div>
    </li>
  );
}
