import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  Connection,
  RemoteEntry,
  SessionOpenResult,
  TunnelConfig,
  TunnelStatus,
} from "../types/protocol";

export function listConnections() {
  return invoke<Connection[]>("list_connections");
}

export function saveConnection(
  conn: Connection,
  password?: string,
  passphrase?: string,
) {
  return invoke<Connection>("save_connection", {
    conn,
    password: password ?? null,
    passphrase: passphrase ?? null,
  });
}

export function deleteConnection(id: string) {
  return invoke<void>("delete_connection", { id });
}

/** Parse ~/.ssh/config (or settings path); does not persist. */
export function importSshConfig() {
  return invoke<Connection[]>("import_ssh_config");
}

/** Copy an imported host into connections.json as Manual. */
export function duplicateSshConfigConnection(conn: Connection) {
  return invoke<Connection>("duplicate_ssh_config_connection", { conn });
}

/** Import PuTTY sessions from Windows Registry. */
export function importPuttySessions() {
  return invoke<Connection[]>("import_putty_sessions");
}

/** List available COM / serial ports. */
export function listSerialPorts() {
  return invoke<string[]>("list_serial_ports");
}

export function sessionOpenLocal() {
  return invoke<SessionOpenResult>("session_open_local", {});
}

export function sessionOpen(
  connectionId: string,
  cols?: number,
  rows?: number,
) {
  return invoke<SessionOpenResult>("session_open", {
    connectionId,
    cols: cols ?? null,
    rows: rows ?? null,
  });
}

export function sessionClose(sessionId: string) {
  return invoke<void>("session_close", { sessionId });
}

/** Close old session (if tracked) and open a new one for the same connection. */
export function sessionReconnect(
  sessionId: string,
  cols?: number,
  rows?: number,
) {
  return invoke<SessionOpenResult>("session_reconnect", {
    sessionId,
    cols: cols ?? null,
    rows: rows ?? null,
  });
}

/** `dataB64` is base64-encoded terminal input bytes. */
export function terminalWrite(
  sessionId: string,
  channelId: string,
  dataB64: string,
) {
  return invoke<void>("terminal_write", {
    sessionId,
    channelId,
    data: dataB64,
  });
}

export function terminalResize(
  sessionId: string,
  channelId: string,
  cols: number,
  rows: number,
) {
  return invoke<void>("terminal_resize", {
    sessionId,
    channelId,
    cols,
    rows,
  });
}

export function sftpList(sessionId: string, path: string) {
  return invoke<RemoteEntry[]>("sftp_list", { sessionId, path });
}

export function sftpMkdir(sessionId: string, path: string) {
  return invoke<void>("sftp_mkdir", { sessionId, path });
}

export function sftpRm(sessionId: string, path: string) {
  return invoke<void>("sftp_rm", { sessionId, path });
}

export function sftpRename(sessionId: string, from: string, to: string) {
  return invoke<void>("sftp_rename", { sessionId, from, to });
}

export function sftpRealpath(sessionId: string, path: string) {
  return invoke<string>("sftp_realpath", { sessionId, path });
}

/** Returns transfer_id; progress via transfer-progress events. */
export function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
) {
  return invoke<string>("sftp_upload", { sessionId, localPath, remotePath });
}

export function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
) {
  return invoke<string>("sftp_download", {
    sessionId,
    remotePath,
    localPath,
  });
}

export function transferCancel(transferId: string) {
  return invoke<void>("transfer_cancel", { transferId });
}

export function sftpReadText(sessionId: string, remotePath: string) {
  return invoke<string>("sftp_read_text", { sessionId, remotePath });
}

export function sftpWriteText(sessionId: string, remotePath: string, contentB64: string) {
  return invoke<void>("sftp_write_text", { sessionId, remotePath, contentB64 });
}

export function tunnelStart(sessionId: string, config: TunnelConfig) {
  return invoke<void>("tunnel_start", { sessionId, config });
}

export function tunnelStop(sessionId: string, tunnelId: string) {
  return invoke<void>("tunnel_stop", { sessionId, tunnelId });
}

export function tunnelList(sessionId: string) {
  return invoke<TunnelStatus[]>("tunnel_list", { sessionId });
}

export function getSettings() {
  return invoke<AppSettings>("get_settings");
}

export function saveSettings(settings: AppSettings) {
  return invoke<AppSettings>("save_settings", { settings });
}

export function clearAllCredentials() {
  return invoke<void>("clear_all_credentials");
}

/** Trust a host key fingerprint (`host` is `host:port`). */
export function hostKeyTrust(
  host: string,
  fingerprint: string,
  keyType?: string,
) {
  return invoke<void>("host_key_trust", {
    host,
    fingerprint,
    keyType: keyType ?? null,
  });
}

/**
 * Export connections JSON. Default omits secrets.
 * When `includeSecrets` is true, pass `confirm: "EXPORT_SECRETS"`.
 * Keyring secret *values* are never embedded — only credential ids.
 */
export function exportConnections(
  includeSecrets = false,
  confirm?: string | null,
) {
  return invoke<string>("export_connections", {
    includeSecrets,
    confirm: confirm ?? null,
  });
}

/** Import connections from export JSON (envelope or bare array). Returns count. */
export function importConnections(json: string) {
  return invoke<number>("import_connections", { json });
}
