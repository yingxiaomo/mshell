//! Known-host fingerprint store (SHA256) under `app_data_dir()/known_hosts.json`.
//!
//! First-seen keys are accepted and persisted. A later key with a different
//! fingerprint for the same `host:port` yields [`CoreError::HostKeyChanged`].

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::CoreError;

/// Serialize known-host load-modify-save critical sections. Concurrent first-seen
/// writes (two sessions connecting to different hosts at once) must not
/// read-modify-write the same file and lose each other's entries.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

/// How to treat host keys during connect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KnownHostsPolicy {
    /// Accept first-seen keys into the store; error if the fingerprint changes.
    #[default]
    StoreAndCompare,
    /// Reject any host not already in the store (strict / pre-prompt path).
    Strict,
    /// Accept any key without persisting (debug / tests only).
    AcceptAll,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    /// `host:port` identity key.
    pub host: String,
    /// OpenSSH-style `SHA256:<base64>` fingerprint of the raw host key blob.
    pub fingerprint: String,
    pub key_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostsFile {
    pub hosts: Vec<KnownHostEntry>,
}

/// Build the map key used in known_hosts for a connection endpoint.
pub fn host_port_key(host: &str, port: u16) -> String {
    format!("{host}:{port}")
}

/// SHA256 fingerprint of a raw host key blob (`SHA256:<standard base64>`).
pub fn fingerprint_sha256(key_bytes: &[u8]) -> String {
    let digest = Sha256::digest(key_bytes);
    let b64 = base64::engine::general_purpose::STANDARD.encode(digest);
    format!("SHA256:{b64}")
}

/// Compare two fingerprints for equality (case-sensitive, full string).
pub fn fingerprints_equal(a: &str, b: &str) -> bool {
    a == b
}

/// Default path: `{dirs::data_dir()}/mshell/known_hosts.json`.
pub fn default_known_hosts_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("mshell")
        .join("known_hosts.json")
}

/// Load known hosts JSON; missing file → empty list.
pub fn load_known_hosts(path: &Path) -> Result<KnownHostsFile, CoreError> {
    if !path.exists() {
        return Ok(KnownHostsFile::default());
    }
    let data = fs::read_to_string(path)?;
    if data.trim().is_empty() {
        return Ok(KnownHostsFile::default());
    }
    Ok(serde_json::from_str(&data)?)
}

/// Persist known hosts JSON (creates parent dirs) via an atomic replace: write a
/// sibling temp file, fsync, then rename over the target so a crash mid-write
/// never leaves a truncated known_hosts.json behind.
pub fn save_known_hosts(path: &Path, file: &KnownHostsFile) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(file)?;
    atomic_write(path, data.as_bytes())
}

/// Write `data` to `path` atomically (temp file + rename in the same dir).
fn atomic_write(path: &Path, data: &[u8]) -> Result<(), CoreError> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
    let dir = parent.unwrap_or_else(|| Path::new("."));
    let mut tmp = dir.to_path_buf();
    // Same dir → rename() is atomic on the same filesystem.
    let unique = format!(
        ".{}.tmp{}",
        path.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "known_hosts".into()),
        std::process::id()
    );
    tmp.push(unique);
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Clean up the temp file; don't mask the rename failure.
            let _ = fs::remove_file(&tmp);
            Err(e.into())
        }
    }
}

/// Look up a stored entry by `host:port` key.
pub fn find_entry<'a>(file: &'a KnownHostsFile, host_key: &str) -> Option<&'a KnownHostEntry> {
    file.hosts.iter().find(|e| e.host == host_key)
}

/// Upsert an entry by host key (replace fingerprint if present).
pub fn upsert_entry(file: &mut KnownHostsFile, entry: KnownHostEntry) {
    if let Some(existing) = file.hosts.iter_mut().find(|e| e.host == entry.host) {
        *existing = entry;
    } else {
        file.hosts.push(entry);
    }
}

/// Check the presented host key against the store according to `policy`.
///
/// - [`KnownHostsPolicy::AcceptAll`]: always Ok, no disk write.
/// - [`KnownHostsPolicy::StoreAndCompare`]: first-seen → store; mismatch → HostKeyChanged.
/// - [`KnownHostsPolicy::Strict`]: unknown → HostKeyUnknown; mismatch → HostKeyChanged.
pub fn verify_host_key(
    store_path: &Path,
    host: &str,
    port: u16,
    key_bytes: &[u8],
    key_type: &str,
    policy: KnownHostsPolicy,
) -> Result<String, CoreError> {
    let fingerprint = fingerprint_sha256(key_bytes);
    let host_key = host_port_key(host, port);

    if policy == KnownHostsPolicy::AcceptAll {
        return Ok(fingerprint);
    }

    // Serialize load→compare→possibly-save so concurrent first-seen connects
    // can't lose entries (read-modify-write race on the same JSON file).
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_known_hosts(store_path)?;
    match find_entry(&file, &host_key) {
        Some(existing) if fingerprints_equal(&existing.fingerprint, &fingerprint) => {
            Ok(fingerprint)
        }
        Some(_existing) => Err(CoreError::HostKeyChanged {
            fingerprint: fingerprint.clone(),
            host: host_key,
        }),
        None if policy == KnownHostsPolicy::Strict => Err(CoreError::HostKeyUnknown {
            fingerprint,
            host: host_key,
        }),
        None => {
            // First-seen: accept and persist (StoreAndCompare).
            upsert_entry(
                &mut file,
                KnownHostEntry {
                    host: host_key,
                    fingerprint: fingerprint.clone(),
                    key_type: key_type.to_string(),
                },
            );
            save_known_hosts(store_path, &file)?;
            Ok(fingerprint)
        }
    }
}

/// Default OpenSSH client known_hosts path: `{home}/.ssh/known_hosts`.
pub fn default_openssh_known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

/// Convert one OpenSSH known_hosts host token into our `host:port` key.
///
/// `[example.com]:2222` → `example.com:2222`; a bare token is port 22 (matching
/// [`host_port_key`], which is plain `{host}:{port}` — so bare IPv6 stays consistent).
fn normalize_known_host_token(tok: &str) -> Option<String> {
    if tok.is_empty() || tok.starts_with('!') {
        return None; // negations aren't a concrete host we can trust
    }
    if let Some(rest) = tok.strip_prefix('[') {
        if let Some((host, port)) = rest.split_once("]:") {
            return Some(format!("{host}:{port}"));
        }
    }
    Some(format!("{tok}:22"))
}

/// Parse OpenSSH `known_hosts` text into [`KnownHostEntry`] rows.
///
/// Hashed host lines (`|1|…`) are skipped (the host can't be recovered), as are
/// comments, `@revoked` markers (a revoked key must NOT be re-imported as a
/// trusted entry), and unparseable lines. `@cert-authority` markers keep their
/// authority keys (they authorize hosts rather than pin them, and importing the
/// CA key lets us verify signed host keys). Each comma-separated host alias
/// yields its own entry sharing the key fingerprint.
pub fn parse_openssh_known_hosts(content: &str) -> Vec<KnownHostEntry> {
    let mut out = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Handle @marker lines: `@revoked` entries are a deny list — skip them.
        // `@cert-authority` lines keep the rest of the line (the CA key).
        let line = if let Some(rest) = line.strip_prefix('@') {
            if rest.starts_with("revoked") || rest.starts_with("revoked ") {
                continue;
            }
            if let Some(after) = rest.strip_prefix("cert-authority ") {
                after.trim_start()
            } else {
                continue;
            }
        } else {
            line
        };

        let mut parts = line.split_whitespace();
        let (hosts, key_type, key_b64) = match (parts.next(), parts.next(), parts.next()) {
            (Some(h), Some(t), Some(k)) => (h, t, k),
            _ => continue,
        };
        if hosts.starts_with("|1|") {
            continue; // hashed hostnames — not reversible
        }
        let key_bytes = match base64::engine::general_purpose::STANDARD.decode(key_b64) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let fingerprint = fingerprint_sha256(&key_bytes);
        for tok in hosts.split(',') {
            if let Some(host) = normalize_known_host_token(tok) {
                out.push(KnownHostEntry {
                    host,
                    fingerprint: fingerprint.clone(),
                    key_type: key_type.to_string(),
                });
            }
        }
    }
    out
}

/// Import OpenSSH `known_hosts` content into our store (upsert), returning the
/// number of host entries merged.
pub fn import_openssh_known_hosts(store_path: &Path, content: &str) -> Result<usize, CoreError> {
    let entries = parse_openssh_known_hosts(content);
    // Serialize with the same lock used by verify_host_key so a concurrent
    // connect can't clobber half-merged state.
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_known_hosts(store_path)?;
    let n = entries.len();
    for entry in entries {
        upsert_entry(&mut file, entry);
    }
    save_known_hosts(store_path, &file)?;
    Ok(n)
}

/// Pure check used by unit tests: compare stored vs presented without I/O.
pub fn compare_fingerprints(stored: Option<&str>, presented: &str) -> HostKeyCompare {
    match stored {
        None => HostKeyCompare::Unknown,
        Some(s) if fingerprints_equal(s, presented) => HostKeyCompare::Match,
        Some(_) => HostKeyCompare::Changed,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyCompare {
    Match,
    Changed,
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parse_openssh_known_hosts_basic() {
        // "QUJD" is base64 for "ABC" — any valid key blob works for parsing.
        let content = "# comment\n\
             example.com ssh-ed25519 QUJD\n\
             [bastion.example.com]:2222 ssh-rsa QUJD\n\
             host1,host2 ssh-ed25519 QUJD\n\
             |1|aGFzaA==|aGFzaA== ssh-rsa QUJD\n\
             @cert-authority ca.example.com ssh-ed25519 QUJD\n\
             @revoked rev.example.com ssh-ed25519 QUJD\n";
        let entries = parse_openssh_known_hosts(content);
        let hosts: Vec<&str> = entries.iter().map(|e| e.host.as_str()).collect();
        assert!(hosts.contains(&"example.com:22"));
        assert!(hosts.contains(&"bastion.example.com:2222"));
        assert!(hosts.contains(&"host1:22"));
        assert!(hosts.contains(&"host2:22"));
        assert!(hosts.contains(&"ca.example.com:22")); // @cert-authority marker stripped
        assert!(!hosts.iter().any(|h| h.contains("hash"))); // hashed line skipped
        // @revoked is a deny list — its key must NOT be re-imported as trusted.
        assert!(!hosts.iter().any(|h| h.starts_with("rev")));
        assert!(entries[0].fingerprint.starts_with("SHA256:"));
        assert_eq!(entries[0].fingerprint, fingerprint_sha256(b"ABC"));
    }

    #[test]
    fn import_openssh_merges_into_store() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("kh.json");
        let n = import_openssh_known_hosts(&path, "h.example.com ssh-ed25519 QUJD\n").unwrap();
        assert_eq!(n, 1);
        let file = load_known_hosts(&path).unwrap();
        assert_eq!(file.hosts.len(), 1);
        assert_eq!(file.hosts[0].host, "h.example.com:22");
    }

    #[test]
    fn host_port_key_format() {
        assert_eq!(host_port_key("example.com", 22), "example.com:22");
        assert_eq!(host_port_key("10.0.0.1", 2222), "10.0.0.1:2222");
    }

    #[test]
    fn fingerprint_sha256_stable() {
        let a = fingerprint_sha256(b"host-key-blob");
        let b = fingerprint_sha256(b"host-key-blob");
        assert_eq!(a, b);
        assert!(a.starts_with("SHA256:"));
        assert_ne!(a, fingerprint_sha256(b"other-blob"));
    }

    #[test]
    fn fingerprints_equal_exact() {
        assert!(fingerprints_equal("SHA256:abc", "SHA256:abc"));
        assert!(!fingerprints_equal("SHA256:abc", "SHA256:xyz"));
    }

    #[test]
    fn compare_fingerprints_states() {
        assert_eq!(
            compare_fingerprints(None, "SHA256:a"),
            HostKeyCompare::Unknown
        );
        assert_eq!(
            compare_fingerprints(Some("SHA256:a"), "SHA256:a"),
            HostKeyCompare::Match
        );
        assert_eq!(
            compare_fingerprints(Some("SHA256:a"), "SHA256:b"),
            HostKeyCompare::Changed
        );
    }

    #[test]
    fn store_and_compare_first_seen_then_match() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let key = b"ssh-ed25519-key-bytes";
        let fp = fingerprint_sha256(key);

        let got = verify_host_key(
            &path,
            "h",
            22,
            key,
            "ssh-ed25519",
            KnownHostsPolicy::StoreAndCompare,
        )
        .unwrap();
        assert_eq!(got, fp);

        let again = verify_host_key(
            &path,
            "h",
            22,
            key,
            "ssh-ed25519",
            KnownHostsPolicy::StoreAndCompare,
        )
        .unwrap();
        assert_eq!(again, fp);

        let file = load_known_hosts(&path).unwrap();
        assert_eq!(file.hosts.len(), 1);
        assert_eq!(file.hosts[0].fingerprint, fp);
    }

    #[test]
    fn store_and_compare_detects_change() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        verify_host_key(
            &path,
            "h",
            22,
            b"key-v1",
            "ssh-rsa",
            KnownHostsPolicy::StoreAndCompare,
        )
        .unwrap();

        let err = verify_host_key(
            &path,
            "h",
            22,
            b"key-v2",
            "ssh-rsa",
            KnownHostsPolicy::StoreAndCompare,
        )
        .unwrap_err();
        match err {
            CoreError::HostKeyChanged { fingerprint, host } => {
                assert_eq!(fingerprint, fingerprint_sha256(b"key-v2"));
                assert_eq!(host, "h:22");
            }
            other => panic!("expected HostKeyChanged, got {other:?}"),
        }
    }

    #[test]
    fn strict_rejects_unknown() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        let err = verify_host_key(
            &path,
            "new",
            22,
            b"key",
            "ssh-ed25519",
            KnownHostsPolicy::Strict,
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::HostKeyUnknown { .. }));
    }

    #[test]
    fn accept_all_skips_store() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("known_hosts.json");
        verify_host_key(
            &path,
            "h",
            22,
            b"key",
            "ssh-ed25519",
            KnownHostsPolicy::AcceptAll,
        )
        .unwrap();
        assert!(!path.exists());
    }
}
