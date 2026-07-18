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

export function onTerminalOutput(
  handler: (ev: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>(EventName.TERMINAL_OUTPUT, (e) => {
    handler(e.payload);
  });
}

export function onSessionDisconnected(
  handler: (ev: SessionDisconnectedEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionDisconnectedEvent>(
    EventName.SESSION_DISCONNECTED,
    (e) => {
      handler(e.payload);
    },
  );
}

export function onTransferProgress(
  handler: (ev: TransferProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<TransferProgressEvent>(EventName.TRANSFER_PROGRESS, (e) => {
    handler(e.payload);
  });
}

export function onTunnelStatus(
  handler: (ev: TunnelStatus) => void,
): Promise<UnlistenFn> {
  return listen<TunnelStatus>(EventName.TUNNEL_STATUS, (e) => {
    handler(e.payload);
  });
}

/** Encode a JS string as UTF-8 base64 for `terminal_write`. */
export function encodeTerminalInput(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decode base64 terminal output to a binary string suitable for xterm.write. */
export function decodeTerminalOutput(dataB64: string): string {
  const binary = atob(dataB64);
  // Pass through as binary string — xterm accepts UTF-8 byte sequences as string.
  return binary;
}

/** Decode base64 to Uint8Array (alternative write path). */
export function decodeTerminalOutputBytes(dataB64: string): Uint8Array {
  const binary = atob(dataB64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
