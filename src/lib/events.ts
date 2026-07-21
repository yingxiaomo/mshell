import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EventName,
  type TerminalOutputEvent,
  type TransferProgressEvent,
  type TunnelStatus,
} from "../types/protocol";

export type SessionDisconnectedEvent = { sessionId: string; reason: string };

const noopUnlisten: UnlistenFn = () => {};

function safeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  try {
    return listen<T>(event, (e) => handler(e.payload));
  } catch {
    return Promise.resolve(noopUnlisten);
  }
}

// ── Global output buffer (HMR-safe via globalThis) ───────────────────
// Single Tauri listener stores terminal output for ALL sessions.
// TerminalView polls consumeTerminalOutput(); StrictMode remount must not
// permanently drop early MOTD/prompt, so we keep a replayable history.

const BUF_KEY = "__momoshell_term_buf__";
type BufBag = {
  pending: Map<string, Uint8Array[]>;
  history: Map<string, Uint8Array[]>;
  inited: boolean;
};
type GlobalBag = typeof globalThis & { [BUF_KEY]?: BufBag };
const g = globalThis as GlobalBag;
const buf: BufBag =
  g[BUF_KEY] ??
  (g[BUF_KEY] = {
    pending: new Map(),
    history: new Map(),
    inited: false,
  });

const MAX_HISTORY_CHUNKS = 800;

function pushHistory(sessionId: string, chunk: Uint8Array) {
  let h = buf.history.get(sessionId);
  if (!h) {
    h = [];
    buf.history.set(sessionId, h);
  }
  h.push(chunk);
  if (h.length > MAX_HISTORY_CHUNKS) {
    h.splice(0, h.length - MAX_HISTORY_CHUNKS);
  }
}

export async function initEarlyTerminalBuffer(): Promise<void> {
  if (buf.inited) return;
  buf.inited = true;
  await safeListen<TerminalOutputEvent>(EventName.TERMINAL_OUTPUT, (ev) => {
    const chunk = decodeTerminalOutputBytes(ev.dataB64);
    let list = buf.pending.get(ev.sessionId);
    if (!list) {
      list = [];
      buf.pending.set(ev.sessionId, list);
    }
    list.push(chunk);
    pushHistory(ev.sessionId, chunk);
  });
}

/**
 * Take pending (not-yet-consumed) bytes for a session.
 * History is retained so a remount can replay via {@link replayTerminalHistory}.
 */
export function consumeTerminalOutput(sessionId: string): Uint8Array[] {
  const list = buf.pending.get(sessionId);
  if (!list || list.length === 0) return [];
  buf.pending.set(sessionId, []);
  return list;
}

/** Full history for remount / StrictMode recovery (oldest → newest). */
export function replayTerminalHistory(sessionId: string): Uint8Array[] {
  const h = buf.history.get(sessionId);
  if (!h || h.length === 0) return [];
  return h.slice();
}

/** Drop buffers when a session tab is closed. */
export function clearTerminalBuffers(sessionId: string): void {
  buf.pending.delete(sessionId);
  buf.history.delete(sessionId);
}

// ── Other event helpers ────────────────────────────────────────────

export function onSessionDisconnected(
  handler: (ev: SessionDisconnectedEvent) => void,
): Promise<UnlistenFn> {
  return safeListen(EventName.SESSION_DISCONNECTED, handler);
}

export function onTransferProgress(
  handler: (ev: TransferProgressEvent) => void,
): Promise<UnlistenFn> {
  return safeListen(EventName.TRANSFER_PROGRESS, handler);
}

export function onTunnelStatus(
  handler: (ev: TunnelStatus) => void,
): Promise<UnlistenFn> {
  return safeListen(EventName.TUNNEL_STATUS, handler);
}

// ── Base64 helpers ──────────────────────────────────────────────────

export function encodeTerminalInput(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function decodeTerminalOutputBytes(dataB64: string): Uint8Array {
  const bin = atob(dataB64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
