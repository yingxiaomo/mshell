/** Hand-mirrored protocol types (must stay in sync with crates/protocol). */

export type Uuid = string;

/** Sidebar activity views (frontend shell). */
export type SideViewId = "sessions" | "files" | "tunnels" | "settings";

export type AuthMethod =
  | { type: "password"; credentialId: string }
  | {
      type: "privateKey";
      path: string;
      passphraseCredentialId?: string | null;
    }
  | { type: "agent" }
  | {
      type: "certificate";
      keyPath: string;
      certPath: string;
      passphraseCredentialId?: string | null;
    };

export type ConnectionSource =
  | { type: "manual" }
  | { type: "sshConfig"; path: string; hostAlias: string };

export type TunnelType =
  | {
      type: "local";
      localHost: string;
      localPort: number;
      remoteHost: string;
      remotePort: number;
    }
  | {
      type: "remote";
      remoteHost: string;
      remotePort: number;
      localHost: string;
      localPort: number;
    }
  | {
      type: "dynamic";
      localHost: string;
      localPort: number;
    };

export interface TunnelConfig {
  id: Uuid;
  name: string;
  kind: TunnelType;
  autoStart: boolean;
}

export interface Connection {
  id: Uuid;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  group?: string | null;
  tags: string[];
  jumpHost?: Uuid | null;
  tunnels: TunnelConfig[];
  source: ConnectionSource;
  lastConnected?: string | null; // ISO-8601 DateTime
  notes?: string | null;
}

export interface AppSettings {
  theme: string;
  terminalFont: string;
  terminalFontSize: number;
  rememberPasswordDefault: boolean;
  autoReconnect: boolean;
  idleSessionMinutes: number;
  switchToFilesOnOpen: boolean;
  sshConfigPath?: string | null;
  defaultDownloadDir?: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "dark",
  terminalFont: "Cascadia Code, Consolas, monospace",
  terminalFontSize: 14,
  rememberPasswordDefault: true,
  autoReconnect: true,
  idleSessionMinutes: 30,
  switchToFilesOnOpen: true,
  sshConfigPath: null,
  defaultDownloadDir: null,
};

export interface SessionOpenResult {
  sessionId: Uuid;
  connectionId: Uuid;
  terminalChannelId: Uuid;
  name: string;
}

export interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified?: number | null;
}

export interface TerminalOutputEvent {
  sessionId: Uuid;
  channelId: Uuid;
  dataB64: string;
}

export type TransferStatus = "running" | "done" | "failed" | "cancelled";

export interface TransferProgressEvent {
  transferId: Uuid;
  bytes: number;
  total?: number | null;
  status: TransferStatus | string;
  error?: string | null;
}

/** Runtime tunnel status from tunnel_list / tunnel-status events. */
export type TunnelRunState = "starting" | "running" | "stopped" | "error" | string;

export interface TunnelStatus {
  tunnelId: Uuid;
  sessionId: Uuid;
  name: string;
  kind: TunnelType;
  autoStart: boolean;
  state: TunnelRunState;
  error?: string | null;
}

export const EventName = {
  TERMINAL_OUTPUT: "terminal-output",
  TRANSFER_PROGRESS: "transfer-progress",
  TUNNEL_STATUS: "tunnel-status",
  SESSION_DISCONNECTED: "session-disconnected",
} as const;

export type EventName = (typeof EventName)[keyof typeof EventName];

export type ClientError =
  | { kind: "message"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "notFound"; message: string }
  | { kind: "hostKeyChanged"; fingerprint: string; host: string }
  | { kind: "hostKeyUnknown"; fingerprint: string; host: string };

export type HostKeyPromptKind = "hostKeyChanged" | "hostKeyUnknown";

export interface HostKeyPrompt {
  kind: HostKeyPromptKind;
  fingerprint: string;
  /** `host:port` known_hosts key. */
  host: string;
  /** Connection to retry after trust. */
  connectionId: string;
  connectionName?: string;
}

/** Parse Tauri command errors that may be JSON ClientError or plain text. */
export function parseClientError(err: unknown): ClientError {
  const raw = err instanceof Error ? err.message : String(err);
  // Tauri may wrap the payload; try to find a JSON object.
  const candidates = [raw];
  const brace = raw.indexOf("{");
  if (brace > 0) candidates.push(raw.slice(brace));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as ClientError;
      if (v && typeof v === "object" && "kind" in v) return v;
    } catch {
      /* continue */
    }
  }
  return { kind: "message", message: raw };
}

export function clientErrorMessage(err: ClientError): string {
  switch (err.kind) {
    case "message":
    case "auth":
    case "notFound":
      return err.message;
    case "hostKeyChanged":
      return `主机密钥已变更 (${err.host})`;
    case "hostKeyUnknown":
      return `未知主机密钥 (${err.host})`;
  }
}
