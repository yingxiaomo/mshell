use std::sync::Mutex;

use store::{ConnectionStore, SettingsStore};

pub struct AppState {
    pub connections: Mutex<ConnectionStore>,
    /// Loaded in Task 5 for init parity; settings commands arrive in a later task.
    #[allow(dead_code)]
    pub settings: Mutex<SettingsStore>,
}

impl AppState {
    pub fn new(connections: ConnectionStore, settings: SettingsStore) -> Self {
        Self {
            connections: Mutex::new(connections),
            settings: Mutex::new(settings),
        }
    }
}
