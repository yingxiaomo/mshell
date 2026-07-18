//! SSH / SFTP / tunnel core.
//!
//! # Session model
//!
//! One OS thread per live session owns the `ssh2::Session`. Commands arrive via
//! `flume` channels ([`session::SessionCmd`]). See [`session::SessionManager`].

pub mod auth;
pub mod creds;
pub mod error;
pub mod host_key;
pub mod jump;
pub mod session;
pub mod sftp;
pub mod ssh_config;
pub mod terminal;
pub mod transfer;
pub mod tunnel;

pub use auth::{auth_method_label, authenticate};
pub use creds::{
    clear_all_momoshell_secrets, credential_id_for_password, delete_secret, get_secret,
    password_credential_id, set_secret, KeyringSecretStore, SecretStore, SERVICE_NAME,
};
pub use error::CoreError;
pub use host_key::{
    compare_fingerprints, default_known_hosts_path, fingerprint_sha256, fingerprints_equal,
    host_port_key, load_known_hosts, save_known_hosts, upsert_entry, verify_host_key,
    HostKeyCompare, KnownHostEntry, KnownHostsFile, KnownHostsPolicy,
};
pub use jump::resolve_jump_chain;
pub use session::{SessionCmd, SessionEvent, SessionManager};
pub use ssh_config::{
    expand_tilde, hosts_to_connections, import_ssh_config, parse_ssh_config,
    resolve_ssh_config_path, SshConfigHost,
};
pub use transfer::TransferQueue;
pub use tunnel::{TunnelRuntimeInfo, TunnelState};
