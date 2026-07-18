import type { RemoteEntry } from "../../types/protocol";
import { clsx } from "clsx";

export interface RemoteEntryRowProps {
  entry: RemoteEntry;
  onOpen: (entry: RemoteEntry) => void;
}

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function RemoteEntryRow({ entry, onOpen }: RemoteEntryRowProps) {
  return (
    <li>
      <button
        type="button"
        onDoubleClick={() => onOpen(entry)}
        onClick={() => {
          if (entry.isDir) onOpen(entry);
        }}
        className={clsx(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
          "hover:bg-zinc-800/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-600",
          entry.isDir ? "text-zinc-100" : "text-zinc-300",
        )}
        title={entry.path}
      >
        <span className="w-4 shrink-0 text-center text-xs text-zinc-500" aria-hidden>
          {entry.isDir ? "📁" : "📄"}
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        <span className="shrink-0 tabular-nums text-xs text-zinc-600">
          {formatSize(entry.size, entry.isDir)}
        </span>
      </button>
    </li>
  );
}
