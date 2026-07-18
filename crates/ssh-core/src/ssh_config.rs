//! OpenSSH-style `~/.ssh/config` parser (subset for momoshell import).
//!
//! Supports: Host, HostName, User, Port, IdentityFile, CertificateFile,
//! ProxyJump, ForwardAgent, Include. Line-based; expands leading `~` via
//! `dirs::home_dir`. No full shell expansion.

use std::fs;
use std::path::{Path, PathBuf};

use protocol::{AuthMethod, Connection, ConnectionSource};
use uuid::Uuid;

use crate::error::CoreError;

/// One Host block after parsing (may still include wildcards).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConfigHost {
    /// Patterns from the Host line (e.g. `web1`, `*.example.com`).
    pub patterns: Vec<String>,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub certificate_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub forward_agent: Option<bool>,
    /// Absolute path of the config file that defined this host.
    pub source_path: PathBuf,
}

/// Expand a leading `~` or `~/` using [`dirs::home_dir`].
pub fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return dirs::home_dir()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    // Windows-style ~/ also often appears as ~\
    if let Some(rest) = path.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

fn default_ssh_config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ssh")
        .join("config")
}

/// Resolve configured path or default `~/.ssh/config`.
pub fn resolve_ssh_config_path(configured: Option<&str>) -> PathBuf {
    match configured {
        Some(p) if !p.trim().is_empty() => PathBuf::from(expand_tilde(p.trim())),
        _ => default_ssh_config_path(),
    }
}

/// Parse an OpenSSH config file, following relative `Include` paths.
pub fn parse_ssh_config(path: &Path) -> Result<Vec<SshConfigHost>, CoreError> {
    let mut visited = Vec::new();
    parse_ssh_config_inner(path, &mut visited)
}

fn parse_ssh_config_inner(
    path: &Path,
    visited: &mut Vec<PathBuf>,
) -> Result<Vec<SshConfigHost>, CoreError> {
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    if visited.iter().any(|v| v == &canonical) {
        return Ok(Vec::new());
    }
    visited.push(canonical.clone());

    let text = fs::read_to_string(path).map_err(|e| {
        CoreError::Other(format!("read ssh config {}: {e}", path.display()))
    })?;

    let base_dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut current: Option<SshConfigHost> = None;

    for raw_line in text.lines() {
        let line = strip_comment(raw_line).trim();
        if line.is_empty() {
            continue;
        }

        let (key, value) = split_key_value(line);
        if key.is_empty() {
            continue;
        }
        let key_lower = key.to_ascii_lowercase();

        match key_lower.as_str() {
            "host" => {
                if let Some(h) = current.take() {
                    hosts.push(h);
                }
                let patterns: Vec<String> = value
                    .split_whitespace()
                    .filter(|p| !p.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                if patterns.is_empty() {
                    continue;
                }
                current = Some(SshConfigHost {
                    patterns,
                    host_name: None,
                    user: None,
                    port: None,
                    identity_file: None,
                    certificate_file: None,
                    proxy_jump: None,
                    forward_agent: None,
                    source_path: path.to_path_buf(),
                });
            }
            "include" => {
                // Include applies at file level; flush current host first so
                // included hosts appear in document order relative to this point.
                if let Some(h) = current.take() {
                    hosts.push(h);
                }
                for pattern in value.split_whitespace() {
                    let include_path = resolve_include(&base_dir, pattern);
                    // Only expand simple relative/absolute paths (no glob for V1
                    // beyond a single file path). If the path exists as a file, parse it.
                    if include_path.is_file() {
                        let nested = parse_ssh_config_inner(&include_path, visited)?;
                        hosts.extend(nested);
                    } else {
                        // Try glob-like directory expansion: if parent exists, match simple * suffix.
                        if let Some(matched) = expand_include_glob(&include_path) {
                            for p in matched {
                                let nested = parse_ssh_config_inner(&p, visited)?;
                                hosts.extend(nested);
                            }
                        }
                    }
                }
            }
            "hostname" => {
                if let Some(ref mut h) = current {
                    h.host_name = Some(value.to_string());
                }
            }
            "user" => {
                if let Some(ref mut h) = current {
                    h.user = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(ref mut h) = current {
                    if let Ok(p) = value.parse::<u16>() {
                        h.port = Some(p);
                    }
                }
            }
            "identityfile" => {
                if let Some(ref mut h) = current {
                    // First IdentityFile wins for import (common primary key).
                    if h.identity_file.is_none() {
                        h.identity_file = Some(expand_tilde(value));
                    }
                }
            }
            "certificatefile" => {
                if let Some(ref mut h) = current {
                    if h.certificate_file.is_none() {
                        h.certificate_file = Some(expand_tilde(value));
                    }
                }
            }
            "proxyjump" => {
                if let Some(ref mut h) = current {
                    h.proxy_jump = Some(value.to_string());
                }
            }
            "forwardagent" => {
                if let Some(ref mut h) = current {
                    h.forward_agent = Some(parse_yes_no(value));
                }
            }
            _ => {
                // Ignore unsupported keywords.
            }
        }
    }

    if let Some(h) = current.take() {
        hosts.push(h);
    }

    Ok(hosts)
}

fn strip_comment(line: &str) -> &str {
    // OpenSSH: # starts a comment unless inside quotes (simple scan).
    let mut in_quote = false;
    for (i, ch) in line.char_indices() {
        match ch {
            '"' => in_quote = !in_quote,
            '#' if !in_quote => return &line[..i],
            _ => {}
        }
    }
    line
}

fn split_key_value(line: &str) -> (&str, &str) {
    // "Key value" or "Key=value" or "Key = value"
    if let Some((k, v)) = line.split_once('=') {
        return (k.trim(), v.trim());
    }
    let mut parts = line.splitn(2, char::is_whitespace);
    let k = parts.next().unwrap_or("").trim();
    let v = parts.next().unwrap_or("").trim();
    (k, v)
}

fn parse_yes_no(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "yes" | "true" | "1" | "on"
    )
}

fn resolve_include(base_dir: &Path, pattern: &str) -> PathBuf {
    let expanded = expand_tilde(pattern);
    let p = PathBuf::from(&expanded);
    if p.is_absolute() {
        p
    } else {
        base_dir.join(p)
    }
}

/// Minimal glob: only supports a single `*` in the last path component.
fn expand_include_glob(path: &Path) -> Option<Vec<PathBuf>> {
    let name = path.file_name()?.to_string_lossy();
    if !name.contains('*') {
        return None;
    }
    let parent = path.parent()?;
    if !parent.is_dir() {
        return None;
    }
    let (prefix, suffix) = name.split_once('*')?;
    let mut out = Vec::new();
    let rd = fs::read_dir(parent).ok()?;
    for entry in rd.flatten() {
        let fname = entry.file_name();
        let s = fname.to_string_lossy();
        if s.starts_with(prefix) && s.ends_with(suffix) {
            let full = entry.path();
            if full.is_file() {
                out.push(full);
            }
        }
    }
    out.sort();
    Some(out)
}

/// True if every Host pattern is the bare wildcard `*`.
pub fn is_wildcard_only(patterns: &[String]) -> bool {
    !patterns.is_empty() && patterns.iter().all(|p| p == "*")
}

/// Convert parsed hosts into importable [`Connection`]s.
///
/// - Skips Host blocks that are only `*`.
/// - Emits one Connection per non-wildcard pattern alias.
/// - Auth: Certificate if cert+key, else PrivateKey if IdentityFile, else Agent.
/// - Does not write to connections.json; caller merges for display only.
pub fn hosts_to_connections(hosts: &[SshConfigHost]) -> Vec<Connection> {
    let mut out = Vec::new();
    for h in hosts {
        if is_wildcard_only(&h.patterns) {
            continue;
        }
        for alias in &h.patterns {
            if alias.contains('*') || alias.contains('?') {
                // Pattern hosts are not concrete list entries.
                continue;
            }
            let host = h
                .host_name
                .clone()
                .unwrap_or_else(|| alias.clone());
            let username = h.user.clone().unwrap_or_else(|| {
                // OpenSSH default is the local login name; fall back to "root" only if unknown.
                whoami_user().unwrap_or_else(|| "root".into())
            });
            let port = h.port.unwrap_or(22);
            let path_str = h.source_path.to_string_lossy().into_owned();

            let auth = match (&h.identity_file, &h.certificate_file) {
                (Some(key), Some(cert)) => AuthMethod::Certificate {
                    key_path: key.clone(),
                    cert_path: cert.clone(),
                    passphrase_credential_id: None,
                },
                (Some(key), None) => AuthMethod::PrivateKey {
                    path: key.clone(),
                    passphrase_credential_id: None,
                },
                _ => AuthMethod::Agent,
            };

            // Notes carry ProxyJump / ForwardAgent for later Task 14 wiring.
            let mut notes_parts = Vec::new();
            if let Some(ref pj) = h.proxy_jump {
                notes_parts.push(format!("ProxyJump={pj}"));
            }
            if let Some(true) = h.forward_agent {
                notes_parts.push("ForwardAgent=yes".into());
            }
            let notes = if notes_parts.is_empty() {
                None
            } else {
                Some(notes_parts.join("; "))
            };

            out.push(Connection {
                id: Uuid::new_v4(),
                name: alias.clone(),
                host,
                port,
                username,
                auth,
                group: Some("ssh config".into()),
                tags: vec!["ssh-config".into()],
                jump_host: None,
                tunnels: vec![],
                source: ConnectionSource::SshConfig {
                    path: path_str,
                    host_alias: alias.clone(),
                },
                last_connected: None,
                notes,
            });
        }
    }
    out
}

fn whoami_user() -> Option<String> {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|s| !s.is_empty())
}

/// Load ssh config from `configured_path` (or default) and return connections for UI merge.
pub fn import_ssh_config(configured_path: Option<&str>) -> Result<Vec<Connection>, CoreError> {
    let path = resolve_ssh_config_path(configured_path);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let hosts = parse_ssh_config(&path)?;
    Ok(hosts_to_connections(&hosts))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
    }

    #[test]
    fn parse_multi_host_and_include() {
        let main = fixtures_dir().join("main_config");
        let hosts = parse_ssh_config(&main).expect("parse main_config");

        // Host * is present in raw parse
        assert!(
            hosts.iter().any(|h| is_wildcard_only(&h.patterns)),
            "expected Host * block in raw parse"
        );

        // Concrete hosts
        let aliases: Vec<String> = hosts
            .iter()
            .flat_map(|h| h.patterns.iter().cloned())
            .collect();
        assert!(aliases.iter().any(|a| a == "web1"));
        assert!(aliases.iter().any(|a| a == "bastion"));
        assert!(aliases.iter().any(|a| a == "prod-db"));
        assert!(aliases.iter().any(|a| a == "jump-target"));
        assert!(aliases.iter().any(|a| a == "included-box"));

        let web1 = hosts
            .iter()
            .find(|h| h.patterns.iter().any(|p| p == "web1"))
            .expect("web1");
        assert_eq!(web1.host_name.as_deref(), Some("10.0.0.10"));
        assert_eq!(web1.user.as_deref(), Some("deploy"));
        assert_eq!(web1.port, Some(2222));
        assert!(
            web1.identity_file
                .as_ref()
                .is_some_and(|p| p.contains("id_ed25519") && !p.starts_with("~/")),
            "IdentityFile should expand ~: {:?}",
            web1.identity_file
        );

        let bastion = hosts
            .iter()
            .find(|h| h.patterns.iter().any(|p| p == "bastion"))
            .expect("bastion");
        assert!(bastion.certificate_file.is_some());
        assert_eq!(bastion.forward_agent, Some(true));

        let jump = hosts
            .iter()
            .find(|h| h.patterns.iter().any(|p| p == "jump-target"))
            .expect("jump-target");
        assert_eq!(jump.proxy_jump.as_deref(), Some("bastion"));

        let included = hosts
            .iter()
            .find(|h| h.patterns.iter().any(|p| p == "included-box"))
            .expect("included-box from Include");
        assert_eq!(included.host_name.as_deref(), Some("192.168.1.50"));
        assert_eq!(included.port, Some(2200));
    }

    #[test]
    fn hosts_to_connections_skips_wildcard_only() {
        let main = fixtures_dir().join("main_config");
        let hosts = parse_ssh_config(&main).unwrap();
        let conns = hosts_to_connections(&hosts);

        assert!(
            !conns.iter().any(|c| c.name == "*"),
            "must skip Host * only entries"
        );
        // Multi-alias block produces two connections
        assert!(conns.iter().any(|c| c.name == "bastion"));
        assert!(conns.iter().any(|c| c.name == "prod-db"));
        assert!(conns.iter().any(|c| c.name == "web1"));
        assert!(conns.iter().any(|c| c.name == "included-box"));

        let web1 = conns.iter().find(|c| c.name == "web1").unwrap();
        assert_eq!(web1.host, "10.0.0.10");
        assert_eq!(web1.port, 2222);
        assert_eq!(web1.username, "deploy");
        match &web1.auth {
            AuthMethod::PrivateKey { path, .. } => {
                assert!(path.contains("id_ed25519"));
            }
            other => panic!("expected PrivateKey, got {other:?}"),
        }
        match &web1.source {
            ConnectionSource::SshConfig { host_alias, path } => {
                assert_eq!(host_alias, "web1");
                assert!(!path.is_empty());
            }
            ConnectionSource::Manual => panic!("expected SshConfig source"),
        }

        let bastion = conns.iter().find(|c| c.name == "bastion").unwrap();
        match &bastion.auth {
            AuthMethod::Certificate {
                key_path,
                cert_path,
                ..
            } => {
                assert!(key_path.contains("id_rsa"));
                assert!(cert_path.contains("id_rsa-cert"));
            }
            other => panic!("expected Certificate, got {other:?}"),
        }

        let jump = conns.iter().find(|c| c.name == "jump-target").unwrap();
        assert!(
            jump.notes
                .as_ref()
                .is_some_and(|n| n.contains("ProxyJump=bastion")),
            "notes should carry ProxyJump: {:?}",
            jump.notes
        );

        // Agent when no IdentityFile
        // only-wild has no IdentityFile → Agent
        let only = conns.iter().find(|c| c.name == "only-wild").unwrap();
        assert_eq!(only.auth, AuthMethod::Agent);
    }

    #[test]
    fn expand_tilde_replaces_home() {
        let home = dirs::home_dir().expect("home");
        let expanded = expand_tilde("~/.ssh/id_ed25519");
        assert!(expanded.starts_with(home.to_string_lossy().as_ref()));
        assert!(expanded.ends_with("id_ed25519") || expanded.contains("id_ed25519"));
        assert!(!expanded.starts_with("~/"));
    }

    #[test]
    fn missing_config_returns_empty() {
        let path = fixtures_dir().join("does-not-exist-ssh-config");
        let r = import_ssh_config(Some(path.to_str().unwrap()));
        assert!(r.unwrap().is_empty());
    }

    #[test]
    fn is_wildcard_only_logic() {
        assert!(is_wildcard_only(&["*".into()]));
        assert!(!is_wildcard_only(&["web1".into()]));
        assert!(!is_wildcard_only(&["*".into(), "web1".into()]));
        assert!(!is_wildcard_only(&[]));
    }
}
