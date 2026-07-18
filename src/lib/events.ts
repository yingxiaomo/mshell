import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EventName,
  type TerminalOutputEvent,
  type TransferProgressEvent,
  type TunnelStatus,
} from "../types/protocol";

export type SessionDisconnectedEvent = {
  sessionId: string;
  reason: string;
};

/** No-op unlisten when Tauri IPC is unavailable (browser-only preview). */
const noopUnlisten: UnlistenFn = () => {};

async function safeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<T>(event, (e) => {
      handler(e.payload);
    });
  } catch {
    return noopUnlisten;
  }
}

// ── Global early-bird buffer ─────────────────────────────────────────
// Subscribe at app init so output emitted before TerminalView mounts is
// not lost. TerminalView drains the buffer for its session on mount.
const earlyBuffer: Map<string, Uint8Array[]> = new Map();
let globalUnlisten: UnlistenFn | null = null;
let globalForward: ((ev: TerminalOutputEvent) => void) | null = null;

/** Subscribe the global listener (call once from main.tsx / App.tsx). */
export async function initEarlyTerminalBuffer(): Promise<void> {
  if (globalUnlisten) return;
  globalUnlisten = await safeListen<TerminalOutputEvent>(
    EventName.TERMINAL_OUTPUT,
    (ev) => {
      // Forward to live handler if set (faster than buffer → drain).
      if (globalForward) {
        globalForward(ev);
        return;
      }
      // Buffer by sessionId.
      let list = earlyBuffer.get(ev.sessionId);
      if (!list) {
        list = [];
        earlyBuffer.set(ev.sessionId, list);
      }
      list.push(decodeTerminalOutputBytes(ev.dataB64));
    },
  );
}

/** Once TerminalView has its listener attached, drain the buffer for that session. */
export function drainTerminalBuffer(
  sessionId: string,
  liveHandler: (bytes: Uint8Array) => void,
): void {
  const buffered = earlyBuffer.get(sessionId);
  if (buffered && buffered.length > 0) {
    for (const bytes of buffered) {
      liveHandler(bytes);
    }
    earlyBuffer.delete(sessionId);
  }
}

/** Attach the live forward after TerminalView subscribes. */
export function setLiveTerminalForward(
  fn: ((ev: TerminalOutputEvent) => void) | null,
): void {
  globalForward = fn;
}

// ── Individual event helpers (used by TerminalView for live stream) ──

export function onTerminalOutput(
  handler: (ev: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return safeListen(EventName.TERMINAL_OUTPUT, handler);
}

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

// ── Base64 helpers ───────────────────────────────────────────────────

/** Encode a JS string as UTF-8 base64 for `terminal_write`. */
export function encodeTerminalInput(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decode base64 to a binary string (older xterm write path). */
export function decodeTerminalOutput(dataB64: string): string {
  const binary = atob(dataB64);
  return binary;
}

/** Decode base64 to Uint8Array (preferred write path). */
export function decodeTerminalOutputBytes(dataB64: string): Uint8Array {
  const binary = atob(dataB64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
