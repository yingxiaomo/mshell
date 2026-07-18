//! PTY / shell channel helpers for LiveSession workers.
//!
//! All functions run on the session worker thread that owns the `ssh2::Session`.

use std::io::{Read, Write};

use ssh2::{Channel, Session};
use uuid::Uuid;

use crate::error::CoreError;

/// Default terminal type requested from the remote.
pub const DEFAULT_TERM: &str = "xterm-256color";

/// Open a session channel, request a PTY, and start a login shell.
///
/// `sess` should be in **blocking** mode for the handshake steps; the caller
/// may switch to non-blocking afterwards for the read loop.
pub fn open_shell(sess: &Session, cols: u32, rows: u32) -> Result<(Uuid, Channel), CoreError> {
    let mut channel = sess.channel_session()?;
    // (cols, rows, width_px, height_px) — pixel sizes optional/zero.
    channel.request_pty(DEFAULT_TERM, None, Some((cols, rows, 0, 0)))?;
    channel.shell()?;
    Ok((Uuid::new_v4(), channel))
}

/// Notify the remote of a window size change.
pub fn resize(channel: &mut Channel, cols: u32, rows: u32) -> Result<(), CoreError> {
    channel.request_pty_size(cols, rows, Some(0), Some(0))?;
    Ok(())
}

/// Write bytes to the shell channel (stdin).
pub fn write_all(channel: &mut Channel, data: &[u8]) -> Result<(), CoreError> {
    channel.write_all(data)?;
    // Flush is best-effort; non-blocking sessions may return WouldBlock.
    let _ = channel.flush();
    Ok(())
}

/// Read available stdout bytes into `buf`. Returns `Ok(0)` on EOF.
///
/// When the session is non-blocking, `WouldBlock` / timeout map to `Ok(None)`
/// (no data yet) so the worker can poll other channels and commands.
pub fn try_read(channel: &mut Channel, buf: &mut [u8]) -> Result<Option<usize>, CoreError> {
    match channel.read(buf) {
        Ok(0) => Ok(Some(0)),
        Ok(n) => Ok(Some(n)),
        Err(e) if is_would_block(&e) => Ok(None),
        Err(e) => Err(CoreError::Io(e)),
    }
}

/// Read available stderr bytes (same semantics as [`try_read`]).
pub fn try_read_stderr(channel: &mut Channel, buf: &mut [u8]) -> Result<Option<usize>, CoreError> {
    let mut stderr = channel.stderr();
    match stderr.read(buf) {
        Ok(0) => Ok(Some(0)),
        Ok(n) => Ok(Some(n)),
        Err(e) if is_would_block(&e) => Ok(None),
        Err(e) => Err(CoreError::Io(e)),
    }
}

fn is_would_block(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}
