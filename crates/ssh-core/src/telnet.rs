//! Minimal Telnet client for mshell.
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
    ///
    /// IAC sequences that straddle a read boundary (a lone trailing `IAC`, an
    /// `IAC WILL` with the option byte not yet arrived, or an unterminated `SB`)
    /// are carried over in `self.buf` and resumed on the next call, so option
    /// bytes are never leaked into the terminal stream as garbage.
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

        // Prepend any partial IAC sequence carried over from the previous read.
        let data: Vec<u8> = if self.buf.is_empty() {
            raw[..n].to_vec()
        } else {
            let mut v = std::mem::take(&mut self.buf);
            v.extend_from_slice(&raw[..n]);
            v
        };
        let len = data.len();

        // Process: respond to IAC sequences, keep real data
        let mut write_idx = 0;
        let mut i = 0;

        while i < len {
            if data[i] == IAC {
                // Need at least the command byte; otherwise stash and resume.
                if i + 1 >= len {
                    self.buf.extend_from_slice(&data[i..len]);
                    break;
                }
                let cmd = data[i + 1];
                match cmd {
                    WILL | DO | DONT | WONT => {
                        // 3-byte sequence: need the option byte too.
                        if i + 2 >= len {
                            self.buf.extend_from_slice(&data[i..len]);
                            break;
                        }
                        let opt = data[i + 2];
                        match cmd {
                            WILL => {
                                if opt == SUPPRESS_GO_AHEAD || opt == ECHO {
                                    self.send_iac(&[IAC, DO, opt])?;
                                } else {
                                    self.send_iac(&[IAC, DONT, opt])?;
                                }
                            }
                            DO => {
                                if opt == ECHO || opt == SUPPRESS_GO_AHEAD || opt == STATUS {
                                    self.send_iac(&[IAC, WILL, opt])?;
                                } else {
                                    self.send_iac(&[IAC, WONT, opt])?;
                                }
                            }
                            // DONT / WONT: acknowledge by ignoring.
                            _ => {}
                        }
                        i += 3;
                        continue;
                    }
                    SB => {
                        // Subnegotiation: find IAC SE and skip the whole block.
                        if let Some(end) = data[i + 2..len]
                            .windows(2)
                            .position(|w| w[0] == IAC && w[1] == SE)
                        {
                            i += 2 + end + 2;
                            continue;
                        }
                        // SE not in this read yet — stash the whole partial block.
                        self.buf.extend_from_slice(&data[i..len]);
                        break;
                    }
                    IAC => {
                        // Escaped 0xFF — emit a single literal 0xFF data byte.
                        buf[write_idx] = IAC;
                        write_idx += 1;
                        i += 2;
                        if write_idx >= buf.len() {
                            break;
                        }
                        continue;
                    }
                    NOP => {
                        i += 2;
                        continue;
                    }
                    _ => {
                        // Other 2-byte commands (IP, AO, AYT, …) — skip both bytes.
                        i += 2;
                        continue;
                    }
                }
            }
            // Regular data byte
            buf[write_idx] = data[i];
            write_idx += 1;
            i += 1;

            if write_idx >= buf.len() {
                // Output full; keep the unparsed tail for the next call.
                if i < len {
                    self.buf.extend_from_slice(&data[i..len]);
                }
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
