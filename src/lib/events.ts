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

const BUF_KEY = "__mshell_term_buf__";
type BufBag = {
  pending: Map<string, Uint8Array[]>;
  history: Map<string, Uint8Array[]>;
  /** Scrollback carried across a reconnect (new session id → old output),
   *  replayed once into the freshly-created terminal. */
  carryover: Map<string, Uint8Array[]>;
  inited: boolean;
};
type GlobalBag = typeof globalThis & { [BUF_KEY]?: BufBag };
const g = globalThis as GlobalBag;
const buf: BufBag =
  g[BUF_KEY] ??
  (g[BUF_KEY] = {
    pending: new Map(),
    history: new Map(),
    carryover: new Map(),
    inited: false,
  });

const MAX_HISTORY_CHUNKS = 800;
const MAX_PENDING_CHUNKS = 800;

function trimPending(sessionId: string) {
  const p = buf.pending.get(sessionId);
  if (p && p.length > MAX_PENDING_CHUNKS) {
    p.splice(0, p.length - MAX_PENDING_CHUNKS);
  }
}

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
    trimPending(ev.sessionId);
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

/** Move history chunks into pending so the poll timer consumes them gradually.
 *  Only feeds ONCE per session (tracked in `fed`), so remounts / effect re-runs
 *  don't re-inject already-rendered history and duplicate scrollback. */
const fed = new Set<string>();

export function feedHistoryToPending(sessionId: string): void {
  if (fed.has(sessionId)) return;
  const h = buf.history.get(sessionId);
  if (!h || h.length === 0) return;
  let p = buf.pending.get(sessionId);
  if (p && p.length > 0) return; // Already buffered via listener
  if (!p) {
    p = [];
    buf.pending.set(sessionId, p);
  }
  p.unshift(...h);
  fed.add(sessionId);
}

/** Drop buffers when a session tab is closed. */
export function clearTerminalBuffers(sessionId: string): void {
  fed.delete(sessionId);
  buf.pending.delete(sessionId);
  buf.history.delete(sessionId);
  buf.carryover.delete(sessionId);
}

/** On reconnect (old id → new id): carry the old session's scrollback over so
 *  the new terminal replays it, then drop the old buffers. */
export function stashScrollback(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const hist = buf.history.get(oldId);
  const pend = buf.pending.get(oldId);
  const carry: Uint8Array[] = [];
  if (hist && hist.length) carry.push(...hist);
  // Any pending (not-yet-rendered) old output belongs before the reconnect too.
  if (pend && pend.length) carry.push(...pend);
  if (carry.length) buf.carryover.set(newId, carry);
  buf.pending.delete(oldId);
  buf.history.delete(oldId);
}

/** Take (and clear) scrollback carried over from a prior session, to write into
 *  a freshly-created terminal before live output starts. */
export function takeCarryover(sessionId: string): Uint8Array[] {
  const c = buf.carryover.get(sessionId);
  if (!c) return [];
  buf.carryover.delete(sessionId);
  return c;
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
  // 分块用 fromCharCode，避免超大粘贴触发 Maximum call stack（spread 有参数上限）
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function decodeTerminalOutputBytes(dataB64: string): Uint8Array {
  const bin = atob(dataB64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
