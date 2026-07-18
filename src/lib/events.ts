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

// ── Global output buffer ────────────────────────────────────────────
// A single Tauri listener stores terminal output for ALL sessions.
// Each TerminalView calls consumeTerminalOutput() periodically to
// retrieve and write only its own session's data.
const buffer: Map<string, Uint8Array[]> = new Map();

export async function initEarlyTerminalBuffer(): Promise<void> {
  await safeListen<TerminalOutputEvent>(
    EventName.TERMINAL_OUTPUT,
    (ev) => {
      let list = buffer.get(ev.sessionId);
      if (!list) { list = []; buffer.set(ev.sessionId, list); }
      list.push(decodeTerminalOutputBytes(ev.dataB64));
    },
  );
}

/** Atomically take all buffered bytes for a session. Returns them in order. */
export function consumeTerminalOutput(sessionId: string): Uint8Array[] {
  const list = buffer.get(sessionId);
  if (!list || list.length === 0) return [];
  buffer.delete(sessionId);
  return list;
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
