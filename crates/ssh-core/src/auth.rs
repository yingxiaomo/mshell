//! SSH authentication against an established `ssh2::Session`.
//!
//! Single path for Password / PrivateKey / Agent / Certificate so session open
//! and any future re-auth share one implementation.

use std::path::Path;

use protocol::{AuthMethod, Connection};
use ssh2::Session;

use crate::creds;
use crate::error::CoreError;

/// Authenticate `sess` using `conn.auth` and OS credential store secrets.
///
/// Caller must have completed TCP connect + SSH handshake. On success,
/// `sess.authenticated()` is true.
pub fn authenticate(sess: &Session, conn: &Connection) -> Result<(), CoreError> {
    match &conn.auth {
        AuthMethod::Password { credential_id } => {
            let secret = creds::get_secret(credential_id)?
                .ok_or_else(|| CoreError::Auth("password not found".into()))?;
            sess.userauth_password(&conn.username, secret.as_str())?;
            ensure_authenticated(sess, "password rejected")
        }
        AuthMethod::PrivateKey {
            path,
            passphrase_credential_id,
        } => {
            let pass = match passphrase_credential_id {
                Some(id) => creds::get_secret(id)?,
                None => None,
            };
            sess.userauth_pubkey_file(
                &conn.username,
                None,
                Path::new(path),
                pass.as_ref().map(|z| z.as_str()),
            )?;
            ensure_authenticated(sess, "public key rejected")
        }
        AuthMethod::Agent => {
            sess.userauth_agent(&conn.username)?;
            ensure_authenticated(sess, "agent authentication rejected")
        }
        AuthMethod::Certificate {
            key_path,
            cert_path,
            passphrase_credential_id,
        } => {
            // Skeleton: pass certificate file as the public key path where libssh2
            // supports OpenSSH certs. Full cert edge-cases land with polish tasks.
            let pass = match passphrase_credential_id {
                Some(id) => creds::get_secret(id)?,
                None => None,
            };
            sess.userauth_pubkey_file(
                &conn.username,
                Some(Path::new(cert_path)),
                Path::new(key_path),
                pass.as_ref().map(|z| z.as_str()),
            )?;
            ensure_authenticated(sess, "certificate authentication rejected")
        }
    }
}

fn ensure_authenticated(sess: &Session, reject_msg: &str) -> Result<(), CoreError> {
    if sess.authenticated() {
        Ok(())
    } else {
        Err(CoreError::Auth(reject_msg.into()))
    }
}

/// Describe which auth variant would be used (unit-testable, no network/keyring).
pub fn auth_method_label(auth: &AuthMethod) -> &'static str {
    match auth {
        AuthMethod::Password { .. } => "password",
        AuthMethod::PrivateKey { .. } => "private_key",
        AuthMethod::Agent => "agent",
        AuthMethod::Certificate { .. } => "certificate",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::AuthMethod;

    #[test]
    fn auth_method_labels() {
        assert_eq!(
            auth_method_label(&AuthMethod::Password {
                credential_id: "x".into()
            }),
            "password"
        );
        assert_eq!(
            auth_method_label(&AuthMethod::PrivateKey {
                path: "k".into(),
                passphrase_credential_id: None,
            }),
            "private_key"
        );
        assert_eq!(auth_method_label(&AuthMethod::Agent), "agent");
        assert_eq!(
            auth_method_label(&AuthMethod::Certificate {
                key_path: "k".into(),
                cert_path: "c".into(),
                passphrase_credential_id: None,
            }),
            "certificate"
        );
    }
}
