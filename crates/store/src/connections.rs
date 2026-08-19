use std::path::{Path, PathBuf};

use protocol::Connection;
use uuid::Uuid;

use crate::StoreError;

pub struct ConnectionStore {
    path: PathBuf,
    items: Vec<Connection>,
}

impl ConnectionStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let items = if path.exists() {
            let data = std::fs::read_to_string(path)?;
            // Empty / corrupt file must not take down app startup — start with empty list.
            if data.trim().is_empty() {
                Vec::new()
            } else {
                match serde_json::from_str(&data) {
                    Ok(items) => items,
                    Err(e) => {
                        eprintln!(
                            "connections store: failed to parse {}: {e}; starting empty \
                             (a .bak copy of the unparseable file is kept)",
                            path.display()
                        );
                        // Preserve the corrupt file so a parse failure doesn't
                        // silently destroy the user's connections on next save.
                        crate::backup_corrupt(path);
                        Vec::new()
                    }
                }
            }
        } else {
            Vec::new()
        };
        Ok(Self {
            path: path.to_path_buf(),
            items,
        })
    }

    pub fn list(&self) -> Result<Vec<Connection>, StoreError> {
        Ok(self.items.clone())
    }

    pub fn get(&self, id: Uuid) -> Option<Connection> {
        self.items.iter().find(|c| c.id == id).cloned()
    }

    pub fn upsert(&mut self, conn: Connection) -> Result<(), StoreError> {
        if let Some(slot) = self.items.iter_mut().find(|c| c.id == conn.id) {
            *slot = conn;
        } else {
            self.items.push(conn);
        }
        self.flush()
    }

    pub fn delete(&mut self, id: Uuid) -> Result<bool, StoreError> {
        let before = self.items.len();
        self.items.retain(|c| c.id != id);
        self.flush()?;
        Ok(self.items.len() != before)
    }

    /// Insert or update many connections, flushing to disk **once**.
    pub fn upsert_many(&mut self, conns: impl IntoIterator<Item = Connection>) -> Result<usize, StoreError> {
        let mut n = 0;
        for conn in conns {
            if let Some(slot) = self.items.iter_mut().find(|c| c.id == conn.id) {
                *slot = conn;
            } else {
                self.items.push(conn);
            }
            n += 1;
        }
        self.flush()?;
        Ok(n)
    }

    /// Update just the `last_connected` timestamp of a connection in place,
    /// flushing once. No-op (returns `Ok(false)`) if the id is unknown.
    pub fn touch_last_connected(
        &mut self,
        id: Uuid,
        when: chrono::DateTime<chrono::Utc>,
    ) -> Result<bool, StoreError> {
        if let Some(slot) = self.items.iter_mut().find(|c| c.id == id) {
            slot.last_connected = Some(when);
            self.flush()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn flush(&self) -> Result<(), StoreError> {
        let data = serde_json::to_string_pretty(&self.items)?;
        // Safety: never persist raw passwords — only credentialId references.
        // Returns an error (rather than panicking) so a failed integrity check
        // can never poison the mutex guarding this store.
        check_no_raw_password(&data)?;
        crate::atomic_write(&self.path, data.as_bytes())
    }
}

/// Verify serialized connection JSON has no raw password field (only credentialId).
fn check_no_raw_password(json: &str) -> Result<(), StoreError> {
    // camelCase protocol never emits a bare "password" value field for secrets;
    // AuthMethod::Password serializes as { "type": "password", "credentialId": "..." }.
    // Reject any field literally named "password" that is not the auth type tag.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(json) {
        walk_no_raw_password(&value)?;
    }
    Ok(())
}

fn walk_no_raw_password(value: &serde_json::Value) -> Result<(), StoreError> {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                // Disallow a key literally named "password" holding a secret string.
                // The auth type tag is `"type": "password"`, not a key named "password".
                if k == "password" {
                    return Err(StoreError::Integrity(format!(
                        "connections JSON must not contain a raw \"password\" field; \
                         use credentialId instead. found: {v}"
                    )));
                }
                walk_no_raw_password(v)?;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                walk_no_raw_password(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{AuthMethod, ConnectionSource};

    fn sample_connection() -> Connection {
        Connection {
            id: Uuid::new_v4(),
            name: "web1".into(),
            host: "1.2.3.4".into(),
            port: 22,
            username: "root".into(),
            auth: AuthMethod::Password {
                credential_id: "mshell/test/password".into(),
            },
            group: Some("prod".into()),
            tags: vec!["ssh".into()],
            #[allow(dead_code)]
            protocol: Default::default(),
            jump_host: None,
            tunnels: vec![],
            source: ConnectionSource::Manual,
            last_connected: None,
            notes: None,
            serial_config: None,
            on_connect: None,
    color: None,
        }
    }

    #[test]
    fn upsert_and_list_connections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        let c = sample_connection();
        store.upsert(c.clone()).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, c.name);
    }

    #[test]
    fn get_and_delete_connection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        let c = sample_connection();
        let id = c.id;
        store.upsert(c).unwrap();
        assert!(store.get(id).is_some());
        assert!(store.delete(id).unwrap());
        assert!(store.get(id).is_none());
        assert!(!store.delete(id).unwrap());
    }

    #[test]
    fn upsert_updates_existing_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        let mut c = sample_connection();
        store.upsert(c.clone()).unwrap();
        c.name = "web1-renamed".into();
        store.upsert(c.clone()).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "web1-renamed");
    }

    #[test]
    fn reload_from_disk_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let c = sample_connection();
        {
            let mut store = ConnectionStore::open(&path).unwrap();
            store.upsert(c.clone()).unwrap();
        }
        let store = ConnectionStore::open(&path).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], c);
    }

    #[test]
    fn connections_json_never_contains_raw_password_field() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        store.upsert(sample_connection()).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        // Must reference credentials by id (protocol may emit credential_id or credentialId).
        assert!(
            raw.contains("credential_id") || raw.contains("credentialId"),
            "expected credential id field in JSON: {raw}"
        );
        // Parse and walk — check_no_raw_password errors on a key named "password".
        check_no_raw_password(&raw).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        walk_no_raw_password(&value).unwrap();
        // Auth type tag "password" is fine; a raw password secret field is not.
        assert!(raw.contains("\"type\": \"password\"") || raw.contains("\"type\":\"password\""));
        // Never embed a plaintext secret under any password-like value field.
        assert!(
            !raw.contains("\"password\":") || raw.contains("\"type\": \"password\"") || raw.contains("\"type\":\"password\""),
            "must not serialize a raw password value field: {raw}"
        );
    }

    #[test]
    fn raw_password_check_returns_error_not_panic() {
        // A key literally named "password" must be rejected via Result, never panic
        // (a panic here would poison the mutex guarding the store).
        let bad = r#"[{"password":"secret"}]"#;
        assert!(matches!(
            check_no_raw_password(bad),
            Err(StoreError::Integrity(_))
        ));
        let good = r#"[{"type":"password","credentialId":"x"}]"#;
        assert!(check_no_raw_password(good).is_ok());
    }

    #[test]
    fn upsert_many_persists_all_with_one_flush() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        let a = sample_connection();
        let b = sample_connection();
        let n = store.upsert_many(vec![a.clone(), b.clone()]).unwrap();
        assert_eq!(n, 2);
        let reloaded = ConnectionStore::open(&path).unwrap();
        assert_eq!(reloaded.list().unwrap().len(), 2);
    }

    #[test]
    fn touch_last_connected_updates_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        let c = sample_connection();
        let id = c.id;
        store.upsert(c).unwrap();
        let now = chrono::Utc::now();
        assert!(store.touch_last_connected(id, now).unwrap());
        assert!(store.get(id).unwrap().last_connected.is_some());
        // Unknown id is a no-op.
        assert!(!store.touch_last_connected(Uuid::new_v4(), now).unwrap());
    }

    #[test]
    fn open_missing_file_yields_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let store = ConnectionStore::open(&path).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn open_empty_or_invalid_file_yields_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, "").unwrap();
        assert!(ConnectionStore::open(&empty).unwrap().list().unwrap().is_empty());

        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, "{").unwrap();
        assert!(ConnectionStore::open(&bad).unwrap().list().unwrap().is_empty());
    }
}
