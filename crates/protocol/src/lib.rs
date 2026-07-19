//! Shared protocol types for momoshell (Rust ↔ frontend).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: Uuid,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub group: Option<String>,
    pub tags: Vec<String>,
    pub jump_host: Option<Uuid>,
    pub tunnels: Vec<TunnelConfig>,
    pub source: ConnectionSource,
    pub last_connected: Option<DateTime<Utc>>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthMethod {
    // rename_all on the enum only renames variant tags; fields need per-variant rename.
    #[serde(rename_all = "camelCase")]
    Password { credential_id: String },
    #[serde(rename_all = "camelCase")]
    PrivateKey {
        path: String,
        passphrase_credential_id: Option<String>,
    },
    Agent,
    #[serde(rename_all = "camelCase")]
    Certificate {
        key_path: String,
        cert_path: String,
        passphrase_credential_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectionSource {
    Manual,
    #[serde(rename_all = "camelCase")]
    SshConfig { path: String, host_alias: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub id: Uuid,
    pub name: String,
    pub kind: TunnelType,
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TunnelType {
    #[serde(rename_all = "camelCase")]
    Local {
        local_host: String,
        local_port: u16,
        remote_host: String,
        remote_port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Remote {
        remote_host: String,
        remote_port: u16,
        local_host: String,
        local_port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Dynamic {
        local_host: String,
        local_port: u16,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub code_theme: String,
    pub terminal_font: String,
    pub terminal_font_size: u16,
    pub remember_password_default: bool,
    pub auto_reconnect: bool,
    pub idle_session_minutes: u32,
    pub switch_to_files_on_open: bool,
    pub ssh_config_path: Option<String>,
    pub default_download_dir: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            code_theme: "one-dark".into(),
            terminal_font: "Cascadia Code, Consolas, monospace".into(),
            terminal_font_size: 14,
            remember_password_default: true,
            auto_reconnect: true,
            idle_session_minutes: 30,
            switch_to_files_on_open: true,
            ssh_config_path: None,
            default_download_dir: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenResult {
    pub session_id: Uuid,
    pub connection_id: Uuid,
    pub terminal_channel_id: Uuid,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub session_id: Uuid,
    pub channel_id: Uuid,
    pub data_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressEvent {
    pub transfer_id: Uuid,
    pub bytes: u64,
    pub total: Option<u64>,
    pub status: String, // "running" | "done" | "failed" | "cancelled"
    pub error: Option<String>,
}

/// Runtime tunnel status (command replies + `tunnel-status` events).
///
/// `state`: `"starting"` | `"running"` | `"stopped"` | `"error"`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub tunnel_id: Uuid,
    pub session_id: Uuid,
    pub name: String,
    pub kind: TunnelType,
    pub auto_start: bool,
    pub state: String,
    pub error: Option<String>,
}

pub mod events {
    pub const TERMINAL_OUTPUT: &str = "terminal-output";
    pub const TRANSFER_PROGRESS: &str = "transfer-progress";
    pub const TUNNEL_STATUS: &str = "tunnel-status";
    pub const SESSION_DISCONNECTED: &str = "session-disconnected";
}

#[derive(Debug, thiserror::Error, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ClientError {
    #[error("{message}")]
    Message { message: String },
    #[error("auth failed: {message}")]
    Auth { message: String },
    #[error("not found: {message}")]
    NotFound { message: String },
    #[error("host key changed: {fingerprint}")]
    HostKeyChanged { fingerprint: String, host: String },
    #[error("unknown host key: {fingerprint}")]
    HostKeyUnknown { fingerprint: String, host: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_json_roundtrip() {
        let c = Connection {
            id: Uuid::nil(),
            name: "web1".into(),
            host: "1.2.3.4".into(),
            port: 22,
            username: "root".into(),
            auth: AuthMethod::Password {
                credential_id: "momoshell/nil/password".into(),
            },
            group: Some("prod".into()),
            tags: vec![],
            jump_host: None,
            tunnels: vec![],
            source: ConnectionSource::Manual,
            last_connected: None,
            notes: None,
        };
        let s = serde_json::to_string(&c).unwrap();
        let back: Connection = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
        assert!(s.contains("\"type\":\"password\"") || s.contains("\"type\": \"password\""));
        assert!(
            s.contains("credentialId"),
            "AuthMethod fields must serialize as camelCase: {s}"
        );
        assert!(
            !s.contains("credential_id"),
            "AuthMethod must not emit snake_case credential_id: {s}"
        );
    }

    #[test]
    fn auth_method_variants_roundtrip() {
        let variants = vec![
            AuthMethod::Password {
                credential_id: "id".into(),
            },
            AuthMethod::PrivateKey {
                path: "~/.ssh/id_ed25519".into(),
                passphrase_credential_id: Some("pass".into()),
            },
            AuthMethod::Agent,
            AuthMethod::Certificate {
                key_path: "key".into(),
                cert_path: "cert".into(),
                passphrase_credential_id: None,
            },
        ];
        for v in variants {
            let s = serde_json::to_string(&v).unwrap();
            let back: AuthMethod = serde_json::from_str(&s).unwrap();
            assert_eq!(v, back);
        }
    }

    #[test]
    fn tunnel_types_roundtrip() {
        let tunnels = vec![
            TunnelType::Local {
                local_host: "127.0.0.1".into(),
                local_port: 8080,
                remote_host: "10.0.0.1".into(),
                remote_port: 80,
            },
            TunnelType::Remote {
                remote_host: "0.0.0.0".into(),
                remote_port: 9000,
                local_host: "127.0.0.1".into(),
                local_port: 9000,
            },
            TunnelType::Dynamic {
                local_host: "127.0.0.1".into(),
                local_port: 1080,
            },
        ];
        for t in tunnels {
            let s = serde_json::to_string(&t).unwrap();
            let back: TunnelType = serde_json::from_str(&s).unwrap();
            assert_eq!(t, back);
        }
    }

    #[test]
    fn app_settings_default() {
        let s = AppSettings::default();
        assert_eq!(s.theme, "dark");
        assert_eq!(s.terminal_font_size, 14);
        assert!(s.auto_reconnect);
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
        assert!(json.contains("terminalFontSize"));
    }

    #[test]
    fn client_error_roundtrip() {
        let err = ClientError::HostKeyChanged {
            fingerprint: "SHA256:abc".into(),
            host: "example.com".into(),
        };
        let s = serde_json::to_string(&err).unwrap();
        let back: ClientError = serde_json::from_str(&s).unwrap();
        match back {
            ClientError::HostKeyChanged { fingerprint, host } => {
                assert_eq!(fingerprint, "SHA256:abc");
                assert_eq!(host, "example.com");
            }
            _ => panic!("wrong variant"),
        }
        assert!(s.contains("\"kind\":\"hostKeyChanged\"") || s.contains("fingerprint"));

        let unk = ClientError::HostKeyUnknown {
            fingerprint: "SHA256:xyz".into(),
            host: "h:22".into(),
        };
        let su = serde_json::to_string(&unk).unwrap();
        let back_u: ClientError = serde_json::from_str(&su).unwrap();
        match back_u {
            ClientError::HostKeyUnknown { fingerprint, host } => {
                assert_eq!(fingerprint, "SHA256:xyz");
                assert_eq!(host, "h:22");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn event_name_constants() {
        assert_eq!(events::TERMINAL_OUTPUT, "terminal-output");
        assert_eq!(events::TRANSFER_PROGRESS, "transfer-progress");
        assert_eq!(events::TUNNEL_STATUS, "tunnel-status");
        assert_eq!(events::SESSION_DISCONNECTED, "session-disconnected");
    }
}
