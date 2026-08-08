/**
 * 命令注册表 — 集中管理所有 Tauri invoke 调用
 *
 * 每个命令是一个带类型的 `CommandDef` 对象，而非散装函数。
 * 用 `cmd()` 调用，享受完整的 TypeScript 类型推导。
 *
 * 用法:
 *   import { cmd, commands } from "../lib/commands";
 *   const connections = await cmd(commands.listConnections);
 *   // 或传参:
 *   await cmd(commands.sessionOpen, { connectionId: id, cols: 80 });
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  Connection,
  GeneratedKey,
  KnownHostEntry,
  RemoteEntry,
  SessionOpenResult,
  TunnelConfig,
  TunnelStatus,
} from "../../types/protocol";

// ── Key types ──────────────────────────────────────────────────────────

export interface SshKeyInfo {
  name: string;
  path: string;
  keyType: string;
  hasPubkey: boolean;
  fingerprint: string | null;
}

export interface AgentStatus {
  running: boolean;
  keysLoaded: number | null;
}

// ── 基础类型 ──────────────────────────────────────────────────────────────

/** 一个 Tauri 命令的定义 */
export interface CommandDef<TResult, TArgs extends Record<string, unknown> = Record<string, unknown>> {
  /** Tauri 后端命令名称（snake_case） */
  readonly name: string;
  /** 调用该命令 */
  invoke: (args: TArgs) => Promise<TResult>;
  /** 可选：边界处运行时校验后端返回值，防止协议漂移在渲染深处炸成 undefined */
  readonly validate?: (raw: unknown) => TResult;
}

/** 快捷调用函数 */
export function cmd<TResult, TArgs extends Record<string, unknown>>(
  def: CommandDef<TResult, TArgs>,
  args?: TArgs,
): Promise<TResult> {
  const p = def.invoke(args ?? ({} as TArgs));
  const v = def.validate;
  return v ? p.then((r) => v(r as unknown)) : p;
}

/** 命令构建器 */
function make<TResult, TArgs extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  validate?: (raw: unknown) => TResult,
): CommandDef<TResult, TArgs> {
  return {
    name,
    invoke: (args: any) => invoke<TResult>(name, args ?? ({} as any)),
    validate,
  } as any;
}

/** 断言后端返回的是数组，否则在边界处抛出清晰错误。 */
function asArray<T>(what: string): (raw: unknown) => T[] {
  return (raw) => {
    if (!Array.isArray(raw)) {
      throw new Error(`${what}返回了非预期的数据格式（期望数组）`);
    }
    return raw as T[];
  };
}

// ── 命令列表 ──────────────────────────────────────────────────────────────

export const commands = {
  // 连接管理
  listConnections:         make<Connection[]>("list_connections", asArray("连接列表")),
  saveConnection:          make<Connection, { conn: Connection; password?: string | null; passphrase?: string | null }>("save_connection"),
  deleteConnection:        make<void, { id: string }>("delete_connection"),
  importSshConfig:         make<Connection[]>("import_ssh_config", asArray("SSH 配置导入结果")),
  duplicateSshConfigConnection: make<Connection, { conn: Connection }>("duplicate_ssh_config_connection"),
  exportConnections:       make<string, { includeSecrets?: boolean; confirm?: string | null }>("export_connections"),
  importConnections:       make<number, { json: string }>("import_connections"),
  importPuttySessions:     make<Connection[]>("import_putty_sessions", asArray("PuTTY 会话导入结果")),

  // 串口
  listSerialPorts:         make<string[]>("list_serial_ports", asArray("串口列表")),

  // 会话
  sessionOpen:            make<SessionOpenResult, { connectionId: string; cols?: number | null; rows?: number | null }>("session_open"),
  sessionOpenLocal:       make<SessionOpenResult>("session_open_local"),
  sessionOpenAdhoc:       make<SessionOpenResult, { host: string; port?: number | null; username: string; authType: string; password?: string | null; keyPath?: string | null; cols?: number | null; rows?: number | null }>("session_open_adhoc"),
  sessionExec:            make<string, { sessionId: string; command: string }>("session_exec"),
  sessionClose:           make<void, { sessionId: string }>("session_close"),
  sessionReconnect:       make<SessionOpenResult, { sessionId: string; cols?: number | null; rows?: number | null }>("session_reconnect"),
  sessionLogStart:        make<string, { sessionId: string; path?: string | null }>("session_log_start"),
  sessionLogStop:         make<void, { sessionId: string }>("session_log_stop"),

  // 终端
  terminalWrite:          make<void, { sessionId: string; channelId: string; data: string }>("terminal_write"),
  terminalResize:         make<void, { sessionId: string; channelId: string; cols: number; rows: number }>("terminal_resize"),

  // SFTP
  sftpList:               make<RemoteEntry[], { sessionId: string; path: string }>("sftp_list", asArray("目录列表")),
  sftpMkdir:              make<void, { sessionId: string; path: string }>("sftp_mkdir"),
  sftpRm:                 make<void, { sessionId: string; path: string }>("sftp_rm"),
  sftpRename:             make<void, { sessionId: string; from: string; to: string }>("sftp_rename"),
  sftpRealpath:           make<string, { sessionId: string; path: string }>("sftp_realpath"),
  sftpUpload:             make<string, { sessionId: string; localPath: string; remotePath: string }>("sftp_upload"),
  sftpDownload:           make<string, { sessionId: string; remotePath: string; localPath: string }>("sftp_download"),
  transferCancel:         make<void, { transferId: string }>("transfer_cancel"),
  sftpReadText:           make<string, { sessionId: string; remotePath: string }>("sftp_read_text"),
  sftpWriteText:          make<void, { sessionId: string; remotePath: string; contentB64: string }>("sftp_write_text"),
  sftpChmod:              make<void, { sessionId: string; path: string; mode: number }>("sftp_chmod"),

  // 隧道
  tunnelStart:            make<void, { sessionId: string; config: TunnelConfig }>("tunnel_start"),
  tunnelStop:             make<void, { sessionId: string; tunnelId: string }>("tunnel_stop"),
  tunnelList:             make<TunnelStatus[], { sessionId: string }>("tunnel_list", asArray("隧道列表")),

  // 设置
  getSettings:            make<AppSettings>("get_settings"),
  saveSettings:           make<AppSettings, { settings: AppSettings }>("save_settings"),
  clearAllCredentials:    make<void>("clear_all_credentials"),

  // 主机密钥 / 密钥管理
  hostKeyTrust:           make<void, { host: string; fingerprint: string; keyType?: string | null }>("host_key_trust"),
  importKnownHosts:       make<number, { path?: string | null }>("import_known_hosts"),
  listKnownHosts:         make<KnownHostEntry[]>("list_known_hosts", asArray("已信任主机列表")),
  removeKnownHost:        make<boolean, { host: string }>("remove_known_host"),
  generateKeypair:        make<GeneratedKey, { path?: string | null; comment?: string | null }>("generate_keypair"),
  deployPublicKey:        make<boolean, { sessionId: string; publicKey?: string | null; pubPath?: string | null; target?: string | null }>("deploy_public_key"),

  // SSH 密钥管理
  listSshKeys:            make<SshKeyInfo[]>("list_ssh_keys", asArray("密钥列表")),
  readSshPubkey:          make<string, { path: string }>("read_ssh_pubkey"),
  sshAgentStatus:         make<AgentStatus>("ssh_agent_status"),

  // AI 聊天
  aiChat:                 make<void, { messages: { role: string; content: string }[]; apiKey: string; model: string; endpoint: string; requestId: string }>("ai_chat"),
  aiSaveKey:              make<void, { key: string }>("ai_save_key"),
  aiGetKey:               make<string>("ai_get_key"),
  aiHasKey:               make<boolean>("ai_has_key"),
  aiSaveEndpoint:         make<void, { endpoint: string }>("ai_save_endpoint"),
  aiGetEndpoint:          make<string>("ai_get_endpoint"),
  aiListModels:           make<string[], { apiKey: string; endpoint: string }>("ai_list_models", asArray("模型列表")),
  aiTestConnection:       make<string, { apiKey: string; endpoint: string }>("ai_test_connection"),
  // SSH 配置编辑
  readSshConfigText:      make<string, { path?: string | null }>("read_ssh_config_text"),
  writeSshConfigText:     make<void, { path?: string | null; content: string }>("write_ssh_config_text"),
  importMcpServers:       make<Connection[], {}>("import_mcp_servers", asArray("MCP 服务器")),
} as const;
