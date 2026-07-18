//! Local Windows terminal (cmd.exe / PowerShell).
//!
//! Spawns a child process with piped stdin/stdout/stderr and relays bytes to/from
//! the session worker loop. No PTY/ConPTY for V1 — pipe mode works for cmd / pwsh.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use crate::error::CoreError;

/// Wraps a local shell process with byte-level read/write (like TelnetSession).
pub struct LocalSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl LocalSession {
    /// Spawn a local shell. Tries pwsh.exe first, falls back to cmd.exe.
    /// `_cols` / `_rows`: reserved for future ConPTY resize (ignored in V1).
    pub fn spawn(_cols: u32, _rows: u32) -> Result<Self, CoreError> {
        let shell = detect_shell();
        let mut cmd = Command::new(&shell);
        // Cleaner interactive experience without banner spam.
        if shell.contains("powershell") || shell == "pwsh.exe" {
            cmd.args(["-NoLogo", "-NoExit"]);
        } else if shell.contains("cmd") {
            cmd.arg("/K");
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| CoreError::Other(format!("无法启动本地终端 {shell}: {e}")))?;

        let stdin = child.stdin.take().ok_or_else(|| {
            CoreError::Other(format!("{shell}: failed to open stdin"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CoreError::Other(format!("{shell}: failed to open stdout"))
        })?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    /// Write bytes to stdin of the child process.
    pub fn write(&mut self, data: &[u8]) -> Result<(), CoreError> {
        self.stdin.write_all(data)?;
        self.stdin.flush()?;
        Ok(())
    }

    /// Read available bytes from stdout (non-blocking-ish).
    /// Returns `Ok(None)` if no data yet, `Ok(Some(0))` on EOF (process exited).
    pub fn try_read(&mut self, buf: &mut [u8]) -> Result<Option<usize>, CoreError> {
        // Peek for availability with a very short timeout.
        let ready = self.stdout.fill_buf().map_err(CoreError::Io)?;
        if ready.is_empty() {
            // Check if process still alive
            match self.child.try_wait() {
                Ok(None) => return Ok(None), // alive but no data
                Ok(Some(_)) => return Ok(Some(0)), // exited
                Err(e) => return Err(CoreError::Io(e)),
            }
        }

        // Read available bytes (not necessarily full fill_buf, but simple approach)
        let n = self.stdout.read(buf)?;
        if n == 0 {
            return Ok(Some(0)); // EOF = process exited
        }
        Ok(Some(n))
    }

    /// Set stdin/stdout to non-blocking mode (best-effort).
    pub fn set_nonblocking(&mut self) -> Result<(), CoreError> {
        // Pipes on Windows don't support non-blocking easily.
        // The try_read using fill_buf gives us a reasonable poll loop.
        Ok(())
    }

    /// Kill the child process.
    pub fn kill(&mut self) -> Result<(), CoreError> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        Ok(())
    }
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Detect available shell: prefer pwsh.exe, fall back to cmd.exe.
fn detect_shell() -> String {
    // Try PowerShell Core first (pwsh.exe), then Windows PowerShell, then cmd.
    for name in &["pwsh.exe", "powershell.exe", "cmd.exe"] {
        if which(name) {
            return name.to_string();
        }
    }
    "cmd.exe".to_string()
}

fn which(name: &str) -> bool {
    std::process::Command::new("where.exe")
        .arg(name)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
