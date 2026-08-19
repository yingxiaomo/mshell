//! Local Windows terminal (cmd.exe / PowerShell).
//!
//! Spawns a child process with piped stdin/stdout/stderr and relays bytes to/from
//! the session worker loop. No PTY/ConPTY for V1 — pipe mode works for cmd / pwsh.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::thread::JoinHandle;

use crate::error::CoreError;

/// Wraps a local shell process with byte-level read/write (like TelnetSession).
///
/// Child stdout is drained on a dedicated reader thread and delivered over a
/// channel, so [`try_read`](LocalSession::try_read) never blocks the session
/// command loop while the child sits idle at a prompt.
pub struct LocalSession {
    child: Child,
    stdin: ChildStdin,
    /// Bytes read from the child stdout by the reader thread.
    rx: Receiver<Vec<u8>>,
    /// Reader thread handle (joined on drop, best-effort).
    reader: Option<JoinHandle<()>>,
    /// Second reader for child stderr (merged into `rx`; L5).
    stderr_reader: Option<JoinHandle<()>>,
    /// Set once the reader thread observes EOF on child stdout.
    stdout_closed: bool,
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
            // Merge stderr (piped + drained into the same channel) so child
            // errors like PowerShell "command not found" reach the terminal
            // instead of being silently discarded (L5).
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| CoreError::Other(format!("无法启动本地终端 {shell}: {e}")))?;

        let stdin = child.stdin.take().ok_or_else(|| {
            CoreError::Other(format!("{shell}: failed to open stdin"))
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CoreError::Other(format!("{shell}: failed to open stdout"))
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            CoreError::Other(format!("{shell}: failed to open stderr"))
        })?;

        // Drain stdout AND stderr on dedicated threads so the command loop never
        // blocks in a pipe read while the child is idle. Each thread exits on EOF
        // (child closes the pipe) or when the receiver is dropped. Stderr bytes
        // are interleaved into the same output stream (best-effort ordering).
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let tx_err = tx.clone();
        let reader = std::thread::Builder::new()
            .name("local-stdout-reader".into())
            .spawn(move || {
                let mut stdout = stdout;
                let mut buf = [0u8; 32 * 1024];
                loop {
                    match stdout.read(&mut buf) {
                        Ok(0) => break,           // EOF: process closed stdout
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;            // receiver gone
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| CoreError::Other(format!("spawn local reader: {e}")))?;
        let stderr_reader = std::thread::Builder::new()
            .name("local-stderr-reader".into())
            .spawn(move || {
                let mut stderr = stderr;
                let mut buf = [0u8; 32 * 1024];
                loop {
                    match stderr.read(&mut buf) {
                        Ok(0) => break,           // EOF: process closed stderr
                        Ok(n) => {
                            if tx_err.send(buf[..n].to_vec()).is_err() {
                                break;            // receiver gone
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| CoreError::Other(format!("spawn local stderr reader: {e}")))?;

        Ok(Self {
            child,
            stdin,
            rx,
            reader: Some(reader),
            stderr_reader: Some(stderr_reader),
            stdout_closed: false,
        })
    }

    /// Write bytes to stdin of the child process.
    pub fn write(&mut self, data: &[u8]) -> Result<(), CoreError> {
        self.stdin.write_all(data)?;
        self.stdin.flush()?;
        Ok(())
    }

    /// Read available bytes produced by the reader thread (never blocks).
    /// Returns `Ok(None)` if no data yet, `Ok(Some(0))` on EOF (process exited).
    pub fn try_read(&mut self, buf: &mut [u8]) -> Result<Option<usize>, CoreError> {
        match self.rx.try_recv() {
            Ok(chunk) => {
                // Reader chunks are ≤ 32 KiB and callers pass a 32 KiB buffer,
                // so `n == chunk.len()` in practice (no truncation loss).
                let n = chunk.len().min(buf.len());
                buf[..n].copy_from_slice(&chunk[..n]);
                Ok(Some(n))
            }
            Err(TryRecvError::Empty) => {
                if self.stdout_closed {
                    return Ok(Some(0));
                }
                // No data buffered — check whether the process has exited.
                match self.child.try_wait() {
                    Ok(None) => Ok(None),        // alive but idle
                    Ok(Some(_)) => Ok(None),     // exited; drain remaining chunks first
                    Err(e) => Err(CoreError::Io(e)),
                }
            }
            Err(TryRecvError::Disconnected) => {
                // Reader thread ended → stdout EOF. Signal process exit.
                self.stdout_closed = true;
                Ok(Some(0))
            }
        }
    }

    /// Set stdin/stdout to non-blocking mode (best-effort). No-op: the reader
    /// thread already decouples blocking reads from the caller.
    pub fn set_nonblocking(&mut self) -> Result<(), CoreError> {
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
        // Reader threads exit once stderr/stdout close (child killed) or rx drops.
        if let Some(h) = self.reader.take() {
            let _ = h.join();
        }
        if let Some(h) = self.stderr_reader.take() {
            let _ = h.join();
        }
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
