//! Local persistence for connections and app settings.

mod connections;
mod error;
mod paths;
mod settings;

use std::io::Write;
use std::path::Path;

pub use connections::ConnectionStore;
pub use error::StoreError;
pub use paths::{app_data_dir, connections_path, settings_path};
pub use settings::SettingsStore;

/// Atomically write `data` to `path`.
///
/// Serializes to a sibling temp file in the same directory, fsyncs it, then
/// renames over the destination. `rename` is atomic on the same volume on both
/// Windows and POSIX, so a crash or power loss mid-write can never leave the
/// destination truncated or half-written — readers see either the old file or
/// the complete new one.
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty());
    let mut tmp = match dir {
        Some(d) => tempfile::NamedTempFile::new_in(d)?,
        None => tempfile::NamedTempFile::new()?,
    };
    tmp.write_all(data)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path).map_err(|e| StoreError::Io(e.error))?;
    Ok(())
}

/// Best-effort backup of a file that failed to parse, so a corrupt store is
/// preserved (as `<name>.bak`) instead of being silently overwritten on the
/// next save. Failures here are non-fatal.
pub(crate) fn backup_corrupt(path: &Path) {
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    let _ = std::fs::copy(path, std::path::PathBuf::from(bak));
}
