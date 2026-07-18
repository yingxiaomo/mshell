use thiserror::Error;

/// Errors from SSH / credential core operations.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("auth error: {0}")]
    Auth(String),

    #[error("{0}")]
    Other(String),
}
