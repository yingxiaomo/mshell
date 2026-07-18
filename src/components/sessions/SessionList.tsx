import { useEffect, useMemo, useState } from "react";
import type { Connection, HostKeyPrompt } from "../../types/protocol";
import {
  clientErrorMessage,
  parseClientError,
} from "../../types/protocol";
import { useConnectionsStore } from "../../stores/connections";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { sessionOpen } from "../../lib/tauri";
import { ConnectionDialog } from "../connection/ConnectionDialog";
import { HostKeyDialog } from "../connection/HostKeyDialog";
import { SessionListItem } from "./SessionListItem";

export function SessionList() {
  const items = useConnectionsStore((s) => s.items);
  const imported = useConnectionsStore((s) => s.imported);
  const loading = useConnectionsStore((s) => s.loading);
  const error = useConnectionsStore((s) => s.error);
  const load = useConnectionsStore((s) => s.load);
  const remove = useConnectionsStore((s) => s.remove);
  const allFn = useConnectionsStore((s) => s.all);
  const duplicateAsLocal = useConnectionsStore((s) => s.duplicateAsLocal);

  const merged = useMemo(
    () => allFn(),
    // Recompute when local or imported lists change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, imported, allFn],
  );

  const addTab = useSessionsStore((s) => s.addTab);
  const setOpening = useSessionsStore((s) => s.setOpening);
  const setOpenError = useSessionsStore((s) => s.setOpenError);
  const opening = useSessionsStore((s) => s.opening);
  const switchToFilesOnOpen = useSettingsStore(
    (s) => s.settings.switchToFilesOnOpen,
  );
  const setActiveView = useUiStore((s) => s.setActiveView);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [hostKeyPrompt, setHostKeyPrompt] = useState<HostKeyPrompt | null>(
    null,
  );
  const [collapsedGroups, setCollapsedGroups] = useState<
    Record<string, boolean>
  >({});

  // Group connections: ungrouped (no group) + per-group.
  const grouped = useMemo(() => {
    const groups = new Map<string, Connection[]>();
    const ungrouped: Connection[] = [];
    for (const c of merged) {
      const g = c.group || "";
      if (!g) {
        ungrouped.push(c);
      } else {
        let list = groups.get(g);
        if (!list) {
          list = [];
          groups.set(g, list);
        }
        list.push(c);
      }
    }
    // Sort groups by key.
    const sortedGroups = [...groups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
    return { ungrouped, groups: sortedGroups };
  }, [merged]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(c: Connection) {
    if (c.source?.type === "sshConfig") return;
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

  async function handleDuplicate(c: Connection) {
    try {
      await duplicateAsLocal(c);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpen(connection: Connection) {
    if (connection.source?.type === "sshConfig") {
      window.alert("导入的 ssh config 主机为只读，请先「复制为本地」再连接。");
      return;
    }
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const result = await sessionOpen(connection.id);
      addTab(result);
      if (switchToFilesOnOpen) {
        setActiveView("files");
      }
    } catch (e) {
      const cerr = parseClientError(e);
      if (
        cerr.kind === "hostKeyChanged" ||
        cerr.kind === "hostKeyUnknown"
      ) {
        setHostKeyPrompt({
          kind: cerr.kind,
          fingerprint: cerr.fingerprint,
          host: cerr.host,
          connectionId: connection.id,
          connectionName: connection.name,
        });
        setOpenError(null);
      } else {
        let msg = clientErrorMessage(cerr);
        if (
          cerr.kind === "auth" &&
          /password not found/i.test(msg)
        ) {
          msg =
            "未找到已保存的密码。请编辑该连接并重新填写密码后保存，再双击连接。";
        }
        setOpenError(msg);
      }
    } finally {
      setOpening(false);
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
        {loading && merged.length === 0 && (
          <p className="text-sm text-zinc-500">加载中…</p>
        )}
        {error && (
          <p className="mb-2 text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
        {!loading && merged.length === 0 && !error && (
          <p className="text-sm text-zinc-500">
            暂无连接。点击「新建」添加 SSH 主机，或将主机写入 ~/.ssh/config。
          </p>
        )}
        <ul className="space-y-2">
          {/* Ungrouped items */}
          {grouped.ungrouped.map((c) => (
            <SessionListItem
              key={
                c.source?.type === "sshConfig"
                  ? `sshcfg:${c.source.path}:${c.source.hostAlias}`
                  : c.id
              }
              connection={c}
              onEdit={openEdit}
              onDelete={handleDelete}
              onOpen={handleOpen}
              onDuplicateAsLocal={handleDuplicate}
            />
          ))}
          {/* Grouped items */}
          {grouped.groups.map(([groupName, items]) => {
            const collapsed = collapsedGroups[groupName] ?? false;
            return (
              <li key={groupName}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
                  onClick={() =>
                    setCollapsedGroups((prev) => ({
                      ...prev,
                      [groupName]: !(
                        prev[groupName] ?? false
                      ),
                    }))
                  }
                >
                  <span className="text-[10px]">
                    {collapsed ? "▶" : "▼"}
                  </span>
                  {groupName}
                  <span className="ml-auto text-[10px] text-zinc-600">
                    {items.length}
                  </span>
                </button>
                {!collapsed && (
                  <ul className="mt-1 space-y-1.5 pl-2">
                    {items.map((c) => (
                      <SessionListItem
                        key={
                          c.source?.type === "sshConfig"
                            ? `sshcfg:${c.source.path}:${c.source.hostAlias}`
                            : c.id
                        }
                        connection={c}
                        onEdit={openEdit}
                        onDelete={handleDelete}
                        onOpen={handleOpen}
                        onDuplicateAsLocal={handleDuplicate}
                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
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
      <HostKeyDialog
        prompt={hostKeyPrompt}
        onClose={() => setHostKeyPrompt(null)}
      />
    </div>
  );
}
