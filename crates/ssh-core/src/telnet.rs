//! Minimal Telnet client for momoshell.
//!
//! Handles raw TCP connection + basic Telnet option negotiation.
//! No encryption, no SFTP, no tunnels — plain terminal relay.
//!
//! # Telnet negotiation
//!
//! We acknowledge `DO` with `WONT` (refuse) for most options, and `WILL` with
//! `DO` only for `ECHO` (server-side echo is fine). This keeps the connection
//! usable for line-mode or character-mode services without a full NVT.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::error::CoreError;

// Telnet IAC codes
const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const NOP: u8 = 241;

// Telnet options
const ECHO: u8 = 1;
const SUPPRESS_GO_AHEAD: u8 = 3;
const STATUS: u8 = 5;
const TIMING_MARK: u8 = 6;
const TERMINAL_TYPE: u8 = 24;
const WINDOW_SIZE: u8 = 31;
const TERMINAL_SPEED: u8 = 32;
const REMOTE_FLOW_CTRL: u8 = 33;
const LINEMODE: u8 = 34;
const ENVIRON: u8 = 39;
const NEW_ENVIRON: u8 = 39;

/// Telnet-over-TCP session wrapper.
pub struct TelnetSession {
    stream: TcpStream,
    /// Buffer for partially-received IAC sequences.
    buf: Vec<u8>,
}

impl TelnetSession {
    /// Connect to `host:port` with timeout and perform minimal negotiation.
    pub fn connect(host: &str, port: u16, timeout: Duration) -> Result<Self, CoreError> {
        let addr = format!("{host}:{port}");
        let stream = match addr.parse::<std::net::SocketAddr>() {
            Ok(sa) => TcpStream::connect_timeout(&sa, timeout)?,
            Err(_) => {
                let s = TcpStream::connect(&addr)?;
                s.set_read_timeout(Some(timeout))?;
                s.set_write_timeout(Some(timeout))?;
                s
            }
        };
        stream.set_read_timeout(Some(Duration::from_millis(50)))?;
        stream.set_write_timeout(Some(timeout))?;
        stream.set_nonblocking(false)?;

        let mut sess = Self {
            stream,
            buf: Vec::with_capacity(128),
        };

        // Send initial negotiation: refuse most DOs, accept server ECHO.
        // IAC WILL SUPPRESS_GO_AHEAD — standard initial handshake.
        sess.send_iac(&[IAC, WILL, SUPPRESS_GO_AHEAD])?;

        // Drain any initial negotiation from server.
        sess.drain_negotiation()?;

        Ok(sess)
    }

    /// Send raw bytes to the remote.
    pub fn write(&mut self, data: &[u8]) -> Result<(), CoreError> {
        self.stream.write_all(data)?;
        Ok(())
    }

    /// Read available bytes, stripping Telnet IAC sequences.
    /// Returns `Ok(None)` when no data yet (non-blocking would-block simulation).
    pub fn try_read(&mut self, buf: &mut [u8]) -> Result<Option<usize>, CoreError> {
        // Read raw bytes
        let mut raw = [0u8; 4096];
        let n = match self.stream.read(&mut raw) {
            Ok(0) => return Ok(Some(0)), // EOF
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Ok(None)
            }
            Err(e) => return Err(CoreError::Io(e)),
        };

        // Process: respond to IAC sequences, keep real data
        let mut write_idx = 0;
        let mut i = 0;

        while i < n {
            if raw[i] == IAC && i + 1 < n {
                let cmd = raw[i + 1];
                match cmd {
                    WILL if i + 2 < n => {
                        let opt = raw[i + 2];
                        // Accept SUPPRESS_GO_AHEAD, refuse others
                        if opt == SUPPRESS_GO_AHEAD || opt == ECHO {
                            self.send_iac(&[IAC, DO, opt])?;
                        } else {
                            self.send_iac(&[IAC, DONT, opt])?;
                        }
                        i += 3;
                        continue;
                    }
                    DO if i + 2 < n => {
                        let opt = raw[i + 2];
                        if opt == ECHO || opt == SUPPRESS_GO_AHEAD || opt == STATUS {
                            self.send_iac(&[IAC, WILL, opt])?;
                        } else {
                            self.send_iac(&[IAC, WONT, opt])?;
                        }
                        i += 3;
                        continue;
                    }
                    DONT | WONT if i + 2 < n => {
                        // Acknowledge: ignore, just advance.
                        i += 3;
                        continue;
                    }
                    SB => {
                        // Subnegotiation: find SE and skip the whole block
                        if let Some(end) = raw[i + 2..n].windows(2)
                            .position(|w| w[0] == IAC && w[1] == SE)
                        {
                            i += 2 + end + 2;
                            continue;
                        }
                        // SE not in this read, stash remainder in buf
                        self.buf.extend_from_slice(&raw[i..n]);
                        break;
                    }
                    NOP => {
                        i += 2;
                        continue;
                    }
                    _ => {
                        // Unknown command (e.g., IP, AO, AYT, etc.) — skip the IAC byte
                        i += 2;
                        continue;
                    }
                }
            }
            // Regular data byte
            buf[write_idx] = raw[i];
            write_idx += 1;
            i += 1;

            if write_idx >= buf.len() {
                break;
            }
        }

        if write_idx == 0 {
            Ok(None)
        } else {
            Ok(Some(write_idx))
        }
    }

    /// Set non-blocking mode for the underlying stream.
    pub fn set_nonblocking(&self, nonblocking: bool) -> Result<(), CoreError> {
        self.stream.set_nonblocking(nonblocking)?;
        Ok(())
    }

    /// Close the socket.
    pub fn close(&mut self) -> Result<(), CoreError> {
        // Send IAC IP (Interrupt Process) + IAC NOP, then shutdown
        let _ = self.send_iac(&[IAC, 244, IAC, NOP]);
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
        Ok(())
    }

    /// Send an IAC sequence (must include IAC prefix).
    fn send_iac(&mut self, cmd: &[u8]) -> Result<(), CoreError> {
        self.stream.write_all(cmd).map_err(CoreError::Io)
    }

    /// Drain and respond to any initial negotiation from server.
    fn drain_negotiation(&mut self) -> Result<(), CoreError> {
        let mut scratch = [0u8; 4096];
        for _ in 0..5 {
            match self.stream.read(&mut scratch) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut i = 0;
                    while i < n {
                        if scratch[i] == IAC && i + 1 < n {
                            let cmd = scratch[i + 1];
                            match cmd {
                                WILL if i + 2 < n => {
                                    let opt = scratch[i + 2];
                                    if opt == SUPPRESS_GO_AHEAD || opt == ECHO {
                                        self.send_iac(&[IAC, DO, opt])?;
                                    } else {
                                        self.send_iac(&[IAC, DONT, opt])?;
                                    }
                                    i += 3;
                                    continue;
                                }
                                DO if i + 2 < n => {
                                    let opt = scratch[i + 2];
                                    self.send_iac(&[IAC, WONT, opt])?;
                                    i += 3;
                                    continue;
                                }
                                SB => {
                                    if let Some(end) = scratch[i + 2..n]
                                        .windows(2)
                                        .position(|w| w[0] == IAC && w[1] == SE)
                                    {
                                        i += 2 + end + 2;
                                        continue;
                                    }
                                    break;
                                }
                                _ => {
                                    i += 2;
                                    continue;
                                }
                            }
                        }
                        break;
                    }
                }
            }
        }
        Ok(())
    }
}
