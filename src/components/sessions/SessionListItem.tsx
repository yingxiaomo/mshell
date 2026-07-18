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

export function SessionListItem({
  connection,
  onEdit,
  onDelete,
  onOpen,
  onDuplicateAsLocal,
}: SessionListItemProps) {
  const imported = isImported(connection);
  const subtitle = `${connection.username}@${connection.host}:${connection.port}`;
  return (
    <li
      className="group flex cursor-pointer items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 hover:border-zinc-700"
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
        {connection.group && (
          <div className="mt-0.5 text-[11px] text-zinc-600">
            {connection.group}
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-1 opacity-80 group-hover:opacity-100">
        {imported ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicateAsLocal?.(connection);
            }}
            className="rounded px-2 py-1 text-xs text-sky-300 hover:bg-zinc-800"
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
