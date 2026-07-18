//! Local / Dynamic (SOCKS5) / Remote port forwards.
//!
//! # Threading
//!
//! Local and Dynamic tunnels bind a local [`TcpListener`] on a companion OS
//! thread. Each accepted connection opens `channel_direct_tcpip` on a cloned
//! `ssh2::Session` (internally `Arc`+mutex) and relays bytes with a short poll loop.
//!
//! Remote forwards use `channel_forward_listen` on the session worker; accepts
//! are polled from the worker loop (best-effort).

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use protocol::{TunnelConfig, TunnelStatus, TunnelType};
use ssh2::{Channel, Session};
use uuid::Uuid;

use crate::error::CoreError;

/// Snapshot used by the session worker for list / events.
#[derive(Debug, Clone)]
pub struct TunnelRuntimeInfo {
    pub config: TunnelConfig,
    pub state: TunnelState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelState {
    Starting,
    Running,
    Stopped,
    Error,
}

impl TunnelState {
    pub fn as_str(self) -> &'static str {
        match self {
            TunnelState::Starting => "starting",
            TunnelState::Running => "running",
            TunnelState::Stopped => "stopped",
            TunnelState::Error => "error",
        }
    }
}

impl TunnelRuntimeInfo {
    pub fn to_status(&self, session_id: Uuid) -> TunnelStatus {
        TunnelStatus {
            tunnel_id: self.config.id,
            session_id,
            name: self.config.name.clone(),
            kind: self.config.kind.clone(),
            auto_start: self.config.auto_start,
            state: self.state.as_str().into(),
            error: self.error.clone(),
        }
    }
}

/// Handle owned by the session worker for a live local/dynamic tunnel thread.
pub struct LocalTunnelHandle {
    pub info: TunnelRuntimeInfo,
    pub stop: Arc<AtomicBool>,
    pub bind_host: String,
    pub bind_port: u16,
    /// Joined on stop/shutdown (best-effort).
    pub thread: Option<thread::JoinHandle<()>>,
}

/// Remote forward: listener lives on the session worker (same thread as Session).
pub struct RemoteTunnelHandle {
    pub info: TunnelRuntimeInfo,
    pub listener: ssh2::Listener,
    pub local_host: String,
    pub local_port: u16,
    pub stop: Arc<AtomicBool>,
}

/// Parse bind host:port from tunnel config fields.
pub fn bind_addr(host: &str, port: u16) -> Result<SocketAddr, CoreError> {
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    format!("{host}:{port}")
        .parse::<SocketAddr>()
        .map_err(|e| CoreError::Other(format!("invalid bind address {host}:{port}: {e}")))
}

/// Bind a TCP listener for local/dynamic tunnels.
pub fn bind_listener(host: &str, port: u16) -> Result<TcpListener, CoreError> {
    let addr = bind_addr(host, port)?;
    TcpListener::bind(addr).map_err(|e| {
        CoreError::Io(io::Error::new(
            e.kind(),
            format!("bind {addr} failed: {e}"),
        ))
    })
}

/// Force-unblock a blocking `accept` by connecting to the local bind address.
pub fn wake_listener(host: &str, port: u16) {
    let host = if host.is_empty() { "127.0.0.1" } else { host };
    let addr = format!("{host}:{port}")
        .parse::<SocketAddr>()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port)));
    let _ = TcpStream::connect_timeout(&addr, Duration::from_millis(200));
}

/// Bidirectional byte relay (poll loop; works with non-blocking sockets).
pub fn relay_bidirectional(mut stream: TcpStream, mut channel: Channel, stop: &AtomicBool) {
    let _ = stream.set_nonblocking(true);
    // Channel I/O follows the session blocking mode; non-blocking preferred here.
    // Callers typically leave the session non-blocking after opening the channel.

    let mut buf_s2c = [0u8; 32 * 1024];
    let mut buf_c2s = [0u8; 32 * 1024];

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        // TCP → SSH
        match stream.read(&mut buf_s2c) {
            Ok(0) => break,
            Ok(n) => {
                if write_all_channel(&mut channel, &buf_s2c[..n]).is_err() {
                    break;
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }

        // SSH → TCP
        match channel.read(&mut buf_c2s) {
            Ok(0) => break,
            Ok(n) => {
                if write_all_stream(&mut stream, &buf_c2s[..n]).is_err() {
                    break;
                }
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }

        if channel.eof() {
            break;
        }

        thread::sleep(Duration::from_millis(2));
    }

    let _ = channel.send_eof();
    let _ = channel.close();
    let _ = stream.shutdown(Shutdown::Both);
}

fn write_all_stream(stream: &mut TcpStream, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        match stream.write(data) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "tcp write zero",
                ))
            }
            Ok(n) => data = &data[n..],
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn write_all_channel(channel: &mut Channel, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        match channel.write(data) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "channel write zero",
                ))
            }
            Ok(n) => data = &data[n..],
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => return Err(e),
        }
    }
    let _ = channel.flush();
    Ok(())
}

/// Minimal SOCKS5 (RFC1928) no-auth handshake; returns destination host:port.
pub fn socks5_handshake(stream: &mut TcpStream) -> io::Result<(String, u16)> {
    // greeting: VER NMETHODS METHODS
    let mut hdr = [0u8; 2];
    stream.read_exact(&mut hdr)?;
    if hdr[0] != 0x05 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "not SOCKS5"));
    }
    let nmethods = hdr[1] as usize;
    let mut methods = vec![0u8; nmethods];
    if nmethods > 0 {
        stream.read_exact(&mut methods)?;
    }
    if nmethods > 0 && !methods.iter().any(|&m| m == 0x00) {
        let _ = stream.write_all(&[0x05, 0xFF]);
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "SOCKS5 auth required (only no-auth supported)",
        ));
    }
    stream.write_all(&[0x05, 0x00])?;

    // request: VER CMD RSV ATYP DST.ADDR DST.PORT
    let mut req = [0u8; 4];
    stream.read_exact(&mut req)?;
    if req[0] != 0x05 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "bad SOCKS5 request version",
        ));
    }
    let cmd = req[1];
    let atyp = req[3];
    if cmd != 0x01 {
        socks5_reply(stream, 0x07, "0.0.0.0", 0)?;
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "only SOCKS5 CONNECT supported",
        ));
    }

    let (host, port) = match atyp {
        0x01 => {
            let mut addr = [0u8; 4];
            stream.read_exact(&mut addr)?;
            let mut p = [0u8; 2];
            stream.read_exact(&mut p)?;
            let port = u16::from_be_bytes(p);
            (
                format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]),
                port,
            )
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len)?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name)?;
            let mut p = [0u8; 2];
            stream.read_exact(&mut p)?;
            let port = u16::from_be_bytes(p);
            let host = String::from_utf8_lossy(&name).into_owned();
            (host, port)
        }
        0x04 => {
            let mut addr = [0u8; 16];
            stream.read_exact(&mut addr)?;
            let mut p = [0u8; 2];
            stream.read_exact(&mut p)?;
            let port = u16::from_be_bytes(p);
            let host = std::net::Ipv6Addr::from(addr).to_string();
            (host, port)
        }
        _ => {
            socks5_reply(stream, 0x08, "0.0.0.0", 0)?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported SOCKS5 address type",
            ));
        }
    };

    socks5_reply(stream, 0x00, "0.0.0.0", 0)?;
    Ok((host, port))
}

fn socks5_reply(
    stream: &mut TcpStream,
    rep: u8,
    bind_host: &str,
    bind_port: u16,
) -> io::Result<()> {
    let mut resp = vec![0x05, rep, 0x00, 0x01];
    let ip: [u8; 4] = bind_host
        .parse::<std::net::Ipv4Addr>()
        .map(|a| a.octets())
        .unwrap_or([0, 0, 0, 0]);
    resp.extend_from_slice(&ip);
    resp.extend_from_slice(&bind_port.to_be_bytes());
    stream.write_all(&resp)
}

/// Open direct-tcpip and relay until either side closes or `stop` is set.
pub fn open_direct_tcpip_relay(
    sess: &Session,
    remote_host: &str,
    remote_port: u16,
    stream: TcpStream,
    stop: &AtomicBool,
) -> Result<(), CoreError> {
    sess.set_blocking(true);
    let channel = sess
        .channel_direct_tcpip(remote_host, remote_port, None)
        .map_err(CoreError::from)?;
    // Prefer non-blocking for the poll relay loop.
    sess.set_blocking(false);
    relay_bidirectional(stream, channel, stop);
    Ok(())
}

/// Local-forward accept loop (companion thread).
pub fn run_local_forward_loop(
    sess: Session,
    listener: TcpListener,
    remote_host: String,
    remote_port: u16,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _peer)) => {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let sess_c = sess.clone();
                let rh = remote_host.clone();
                let stop_c = Arc::clone(&stop);
                let _ = thread::Builder::new()
                    .name("tunnel-relay-local".into())
                    .spawn(move || {
                        let _ = open_direct_tcpip_relay(
                            &sess_c, &rh, remote_port, stream, &stop_c,
                        );
                    });
            }
            Err(e) => {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if e.kind() != io::ErrorKind::Interrupted {
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

/// Dynamic SOCKS5 accept loop.
pub fn run_dynamic_forward_loop(sess: Session, listener: TcpListener, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _peer)) => {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let sess_c = sess.clone();
                let stop_c = Arc::clone(&stop);
                let _ = thread::Builder::new()
                    .name("tunnel-relay-socks".into())
                    .spawn(move || {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                        match socks5_handshake(&mut stream) {
                            Ok((host, port)) => {
                                let _ = open_direct_tcpip_relay(
                                    &sess_c, &host, port, stream, &stop_c,
                                );
                            }
                            Err(_) => {
                                let _ = stream.shutdown(Shutdown::Both);
                            }
                        }
                    });
            }
            Err(e) => {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if e.kind() != io::ErrorKind::Interrupted {
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

/// Handle one remote-forwarded inbound channel: connect local and relay.
pub fn handle_remote_inbound(
    channel: Channel,
    local_host: &str,
    local_port: u16,
    stop: &AtomicBool,
) {
    let addr = format!("{local_host}:{local_port}");
    let sa = addr
        .parse::<SocketAddr>()
        .unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], local_port)));
    match TcpStream::connect_timeout(&sa, Duration::from_secs(10)) {
        Ok(stream) => relay_bidirectional(stream, channel, stop),
        Err(_) => {
            let mut channel = channel;
            let _ = channel.close();
        }
    }
}

/// Human-readable summary of a tunnel kind for UI labels.
pub fn kind_label(kind: &TunnelType) -> String {
    match kind {
        TunnelType::Local {
            local_host,
            local_port,
            remote_host,
            remote_port,
        } => format!("L {local_host}:{local_port} → {remote_host}:{remote_port}"),
        TunnelType::Remote {
            remote_host,
            remote_port,
            local_host,
            local_port,
        } => format!("R {remote_host}:{remote_port} → {local_host}:{local_port}"),
        TunnelType::Dynamic {
            local_host,
            local_port,
        } => format!("D SOCKS5 {local_host}:{local_port}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn socks5_connect_ipv4_roundtrip() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            socks5_handshake(&mut stream).unwrap()
        });

        let mut client = TcpStream::connect(addr).unwrap();
        client.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).unwrap();
        assert_eq!(resp, [0x05, 0x00]);
        client
            .write_all(&[0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0, 80])
            .unwrap();
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(reply[0], 0x05);
        assert_eq!(reply[1], 0x00);

        let (host, port) = server.join().unwrap();
        assert_eq!(host, "1.2.3.4");
        assert_eq!(port, 80);
    }

    #[test]
    fn socks5_connect_domain() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            socks5_handshake(&mut stream).unwrap()
        });

        let mut client = TcpStream::connect(addr).unwrap();
        client.write_all(&[0x05, 0x01, 0x00]).unwrap();
        let mut resp = [0u8; 2];
        client.read_exact(&mut resp).unwrap();

        let domain = b"example.com";
        let mut req = vec![0x05, 0x01, 0x00, 0x03, domain.len() as u8];
        req.extend_from_slice(domain);
        req.extend_from_slice(&443u16.to_be_bytes());
        client.write_all(&req).unwrap();
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).unwrap();

        let (host, port) = server.join().unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);
    }

    #[test]
    fn bind_addr_parses() {
        let a = bind_addr("127.0.0.1", 18080).unwrap();
        assert_eq!(a.port(), 18080);
    }
}
