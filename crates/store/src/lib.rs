//! Local persistence for connections and app settings.

mod connections;
mod error;
mod paths;
mod settings;

pub use connections::ConnectionStore;
pub use error::StoreError;
pub use paths::{app_data_dir, connections_path, settings_path};
pub use settings::SettingsStore;
