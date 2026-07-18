//! SSH / SFTP / tunnel core.
//!
//! This crate currently exposes credential helpers only; session/auth land in later tasks.

pub mod creds;
pub mod error;

pub use creds::{
    clear_all_momoshell_secrets, credential_id_for_password, delete_secret, get_secret,
    password_credential_id, set_secret, KeyringSecretStore, SecretStore, SERVICE_NAME,
};
pub use error::CoreError;
