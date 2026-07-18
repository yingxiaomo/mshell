use thiserror::Error;

/// Errors from SSH / credential core operations.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("keyring error: {0}")]
    Keyring(#[from] keyring::Error),

    #[error("auth error: {0}")]
    Auth(String),

    #[error("host key changed: {fingerprint} for {host}")]
    HostKeyChanged { fingerprint: String, host: String },

    #[error("unknown host key: {fingerprint} for {host}")]
    HostKeyUnknown { fingerprint: String, host: String },

    #[error("ssh error: {0}")]
    Ssh(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("session not found: {0}")]
    SessionNotFound(uuid::Uuid),

    #[error("not yet implemented: {0}")]
    NotYet(String),

    #[error("{0}")]
    Other(String),
}

impl From<ssh2::Error> for CoreError {
    fn from(e: ssh2::Error) -> Self {
        CoreError::Ssh(e.to_string())
    }
}
