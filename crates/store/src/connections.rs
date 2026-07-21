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
                            "connections store: failed to parse {}: {e}; starting empty",
                            path.display()
                        );
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

    fn flush(&self) -> Result<(), StoreError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&self.items)?;
        // Safety: never persist raw passwords — only credentialId references.
        assert_no_raw_password(&data);
        std::fs::write(&self.path, data)?;
        Ok(())
    }
}

/// Assert serialized connection JSON has no raw password field (only credentialId).
fn assert_no_raw_password(json: &str) {
    // camelCase protocol never emits a bare "password" value field for secrets;
    // AuthMethod::Password serializes as { "type": "password", "credentialId": "..." }.
    // Reject any field literally named "password" that is not the auth type tag.
    // A raw password leak would look like `"password": "secret"` (value is a string
    // that is not part of the type tag pattern).
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(json) {
        walk_no_raw_password(&value);
    }
}

fn walk_no_raw_password(value: &serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                // Disallow a key literally named "password" holding a secret string.
                // The auth type tag is `"type": "password"`, not a key named "password".
                if k == "password" {
                    panic!(
                        "connections JSON must not contain a raw \"password\" field; \
                         use credentialId instead. found: {v}"
                    );
                }
                walk_no_raw_password(v);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                walk_no_raw_password(item);
            }
        }
        _ => {}
    }
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
                credential_id: "momoshell/test/password".into(),
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
        // Parse and walk — assert_no_raw_password panics on a key named "password".
        assert_no_raw_password(&raw);
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        walk_no_raw_password(&value);
        // Auth type tag "password" is fine; a raw password secret field is not.
        assert!(raw.contains("\"type\": \"password\"") || raw.contains("\"type\":\"password\""));
        // Never embed a plaintext secret under any password-like value field.
        assert!(
            !raw.contains("\"password\":") || raw.contains("\"type\": \"password\"") || raw.contains("\"type\":\"password\""),
            "must not serialize a raw password value field: {raw}"
        );
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
