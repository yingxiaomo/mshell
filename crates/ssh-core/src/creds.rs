//! Windows Credential Manager helpers via the `keyring` crate.
//!
//! Secrets are stored under service name `"momoshell"` with target names like
//! `momoshell/{connection_id}/password`. Retrieved secrets are wrapped in
//! [`zeroize::Zeroizing`] so memory is wiped on drop.

use keyring::Entry;
use zeroize::Zeroizing;

use crate::error::CoreError;

/// Service name used for all momoshell Credential Manager entries.
pub const SERVICE_NAME: &str = "momoshell";

/// Build the credential id (keyring user/target) for a connection password.
///
/// Format: `momoshell/{connection_id}/password`
pub fn password_credential_id(connection_id: uuid::Uuid) -> String {
    format!("momoshell/{connection_id}/password")
}

/// Alias used in the task brief / plan interface list.
#[inline]
pub fn credential_id_for_password(connection_id: uuid::Uuid) -> String {
    password_credential_id(connection_id)
}

/// Store a secret under `credential_id` in the OS credential store.
pub fn set_secret(credential_id: &str, secret: &str) -> Result<(), CoreError> {
    let entry = Entry::new(SERVICE_NAME, credential_id)?;
    entry.set_password(secret)?;
    Ok(())
}

/// Read a secret. Returns `Ok(None)` when no entry exists.
pub fn get_secret(credential_id: &str) -> Result<Option<Zeroizing<String>>, CoreError> {
    let entry = Entry::new(SERVICE_NAME, credential_id)?;
    match entry.get_password() {
        Ok(p) => Ok(Some(Zeroizing::new(p))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Delete a secret. Missing entries are treated as success.
pub fn delete_secret(credential_id: &str) -> Result<(), CoreError> {
    let entry = Entry::new(SERVICE_NAME, credential_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Best-effort clear of all momoshell secrets.
///
/// # Windows / keyring limits
///
/// The `keyring` crate does **not** expose enumeration of Credential Manager
/// entries by service or target-name prefix. Without a separate index of
/// credential ids (e.g. connection records), this function cannot discover or
/// delete orphaned entries.
///
/// Production “clear all credentials” should iterate known
/// `credential_id` / `passphrase_credential_id` values from the connection
/// store and call [`delete_secret`] for each. This helper is a documented
/// placeholder so callers have a single entry point; it currently succeeds
/// without deleting anything. Prefer [`delete_secret`] with known ids.
pub fn clear_all_momoshell_secrets() -> Result<(), CoreError> {
    // Intentionally no-op: see module docs / function docs for Windows limits.
    Ok(())
}

/// Mockable secret backend for unit tests that must not touch the real
/// Credential Manager. Production code uses free functions above; inject this
/// trait at higher layers when testing auth/session flows.
pub trait SecretStore {
    fn set(&self, credential_id: &str, secret: &str) -> Result<(), CoreError>;
    fn get(&self, credential_id: &str) -> Result<Option<Zeroizing<String>>, CoreError>;
    fn delete(&self, credential_id: &str) -> Result<(), CoreError>;
}

/// Production [`SecretStore`] backed by the OS keyring.
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn set(&self, credential_id: &str, secret: &str) -> Result<(), CoreError> {
        set_secret(credential_id, secret)
    }

    fn get(&self, credential_id: &str) -> Result<Option<Zeroizing<String>>, CoreError> {
        get_secret(credential_id)
    }

    fn delete(&self, credential_id: &str) -> Result<(), CoreError> {
        delete_secret(credential_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn password_credential_id_format() {
        let id = Uuid::nil();
        assert_eq!(
            password_credential_id(id),
            "momoshell/00000000-0000-0000-0000-000000000000/password"
        );
    }

    #[test]
    fn password_credential_id_uses_hyphenated_uuid() {
        let id = Uuid::parse_str("550e8400-e29b-41d4-a716-446655440000").unwrap();
        let s = password_credential_id(id);
        assert_eq!(s, format!("momoshell/{id}/password"));
        assert!(s.starts_with("momoshell/"));
        assert!(s.ends_with("/password"));
        assert!(!s.contains('{'));
    }

    #[test]
    fn credential_id_for_password_aliases_password_credential_id() {
        let id = Uuid::new_v4();
        assert_eq!(
            credential_id_for_password(id),
            password_credential_id(id)
        );
    }

    #[test]
    fn clear_all_is_best_effort_ok() {
        assert!(clear_all_momoshell_secrets().is_ok());
    }

    /// Touches real Windows Credential Manager — run with:
    /// `cargo test -p ssh-core creds -- --ignored`
    #[test]
    #[ignore = "requires OS credential store (Windows Credential Manager)"]
    fn keyring_set_get_delete_roundtrip() {
        let id = format!(
            "momoshell/test-{}/password",
            Uuid::new_v4()
        );
        set_secret(&id, "s3cret-test-value").expect("set");
        let got = get_secret(&id).expect("get");
        assert_eq!(got.as_deref().map(|s| s.as_str()), Some("s3cret-test-value"));
        delete_secret(&id).expect("delete");
        assert!(get_secret(&id).expect("get after delete").is_none());
    }
}
