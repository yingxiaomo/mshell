use std::path::{Path, PathBuf};

use protocol::AppSettings;

use crate::StoreError;

pub struct SettingsStore {
    path: PathBuf,
    settings: AppSettings,
}

impl SettingsStore {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let settings = if path.exists() {
            let data = std::fs::read_to_string(path)?;
            serde_json::from_str(&data)?
        } else {
            AppSettings::default()
        };
        Ok(Self {
            path: path.to_path_buf(),
            settings,
        })
    }

    pub fn load(&self) -> AppSettings {
        self.settings.clone()
    }

    pub fn save(&mut self, settings: AppSettings) -> Result<(), StoreError> {
        self.settings = settings;
        self.flush()
    }

    fn flush(&self) -> Result<(), StoreError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&self.settings)?;
        std::fs::write(&self.path, data)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_default_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = SettingsStore::open(&path).unwrap();
        let s = store.load();
        assert_eq!(s.theme, "dark");
        assert_eq!(s.terminal_font_size, 14);
        assert!(s.auto_reconnect);
    }

    #[test]
    fn save_and_reload_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        {
            let mut store = SettingsStore::open(&path).unwrap();
            let mut s = store.load();
            s.theme = "light".into();
            s.terminal_font_size = 16;
            store.save(s).unwrap();
        }
        let store = SettingsStore::open(&path).unwrap();
        let s = store.load();
        assert_eq!(s.theme, "light");
        assert_eq!(s.terminal_font_size, 16);
    }

    #[test]
    fn settings_json_uses_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut store = SettingsStore::open(&path).unwrap();
        store.save(AppSettings::default()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("terminalFontSize"));
        assert!(raw.contains("rememberPasswordDefault"));
    }
}
