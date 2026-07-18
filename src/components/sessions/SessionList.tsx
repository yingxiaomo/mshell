import { useEffect, useState } from "react";
import type { Connection } from "../../types/protocol";
import { useConnectionsStore } from "../../stores/connections";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { SessionListItem } from "./SessionListItem";

export function SessionList() {
  const items = useConnectionsStore((s) => s.items);
  const loading = useConnectionsStore((s) => s.loading);
  const error = useConnectionsStore((s) => s.error);
  const load = useConnectionsStore((s) => s.load);
  const remove = useConnectionsStore((s) => s.remove);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(c: Connection) {
    setEditing(c);
    setDialogOpen(true);
  }

  async function handleDelete(id: string) {
    if (!window.confirm("确定删除该连接？凭据也会一并清除。")) return;
    try {
      await remove(id);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-zinc-200">
          连接
        </h1>
        <button
          type="button"
          onClick={openCreate}
          className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500"
        >
          新建
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {loading && items.length === 0 && (
          <p className="text-sm text-zinc-500">加载中…</p>
        )}
        {error && (
          <p className="mb-2 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        {!loading && items.length === 0 && !error && (
          <p className="text-sm text-zinc-500">
            暂无连接。点击「新建」添加 SSH 主机。
          </p>
        )}
        <ul className="space-y-2">
          {items.map((c) => (
            <SessionListItem
              key={c.id}
              connection={c}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          ))}
        </ul>
      </div>

      <ConnectionDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />
    </div>
  );
}
