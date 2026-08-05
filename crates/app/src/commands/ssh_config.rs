//! SSH config file read/write + MCP host import.

use std::path::PathBuf;

use protocol::{AuthMethod, Connection, ConnectionProtocol, ConnectionSource};
use serde::Deserialize;
use uuid::Uuid;

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .map_err(|_| "找不到用户主目录".to_string())
}

/// Read ~/.ssh/config file content.
#[tauri::command]
pub fn read_ssh_config_text(path: Option<String>) -> Result<String, String> {
    let config_path = path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().unwrap_or_default().join(".ssh").join("config"));

    if !config_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&config_path)
        .map_err(|e| format!("读取 SSH 配置失败：{e}"))
}

/// Write content to ~/.ssh/config.
#[tauri::command]
pub fn write_ssh_config_text(path: Option<String>, content: String) -> Result<(), String> {
    let config_path = path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().unwrap_or_default().join(".ssh").join("config"));

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&config_path, &content)
        .map_err(|e| format!("写入 SSH 配置失败：{e}"))
}

#[derive(Debug, Deserialize)]
struct McpHost {
    name: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    password: Option<String>,
    key: Option<String>,
}

/// Import SSH servers from `~/.ssh/mcp-hosts.json` (ssh-mcp-server format).
/// Returns connections ready to be saved via save_connection.
#[tauri::command]
pub fn import_mcp_servers() -> Result<Vec<Connection>, String> {
    let mcp_path = home_dir()?.join(".ssh").join("mcp-hosts.json");
    if !mcp_path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&mcp_path)
        .map_err(|e| format!("读取 MCP 配置失败：{e}"))?;
    let hosts: Vec<McpHost> = serde_json::from_str(&content)
        .map_err(|e| format!("解析 MCP 配置失败：{e}"))?;
    let conns: Vec<Connection> = hosts.iter().filter_map(mcp_host_to_connection).collect();
    Ok(conns)
}

fn mcp_host_to_connection(h: &McpHost) -> Option<Connection> {
    let name = h.name.as_deref()?;
    let host = h.host.as_deref()?;
    let username = h.username.as_deref().unwrap_or("root");

    let auth = if h.password.as_deref().filter(|p| !p.is_empty()).is_some() {
        AuthMethod::Password { credential_id: format!("momoshell/{}/password", name) }
    } else if h.key.as_deref().filter(|k| !k.is_empty()).is_some() {
        AuthMethod::PrivateKey {
            path: h.key.as_deref().unwrap_or("").into(),
            passphrase_credential_id: None,
        }
    } else {
        AuthMethod::Agent
    };

    Some(Connection {
        id: Uuid::new_v4(),
        name: name.into(),
        host: host.into(),
        port: h.port.unwrap_or(22),
        protocol: ConnectionProtocol::Ssh,
        username: username.into(),
        auth,
        group: Some("MCP".into()),
        tags: vec!["mcp".into()],
        jump_host: None,
        tunnels: vec![],
        source: ConnectionSource::Manual,
        last_connected: None,
        notes: None,
        serial_config: None,
        on_connect: None,
        color: None,
    })
}
