use std::path::PathBuf;

pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("momoshell")
}

pub fn connections_path() -> PathBuf {
    app_data_dir().join("connections.json")
}

pub fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_end_with_expected_names() {
        assert!(connections_path().ends_with("connections.json"));
        assert!(settings_path().ends_with("settings.json"));
        assert!(app_data_dir().ends_with("momoshell"));
    }
}
