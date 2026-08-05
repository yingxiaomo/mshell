//! Tauri 命令中间件 — 消除样板代码。
//!
//! 新增命令应使用此模块的 `OrErr` trait 消除 `map_err(|e| e.to_string())` 样板。

use ssh_core::CoreError;

/// 辅助 trait：将 `Result<T, E: ToString>` 转换为 `Result<T, String>`。
pub trait OrErr<T> {
    fn or_err(self) -> Result<T, String>;
}

impl<T, E: ToString> OrErr<T> for Result<T, E> {
    fn or_err(self) -> Result<T, String> {
        self.map_err(|e| e.to_string())
    }
}

impl<T> OrErr<T> for Option<T> {
    fn or_err(self) -> Result<T, String> {
        self.ok_or_else(|| "value is None".to_string())
    }
}

impl OrErr<()> for CoreError {
    fn or_err(self) -> Result<(), String> {
        Err(self.to_string())
    }
}
