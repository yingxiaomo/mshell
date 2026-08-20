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
use crate::session::SessionEvent;

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

/// Remote forward: listener + accept + relay live on a dedicated thread that
/// owns its own authenticated SSH connection (via `SessionFactory`), so the
/// session is never shared with the tunnel worker thread.
pub struct RemoteTunnelHandle {
    pub info: TunnelRuntimeInfo,
    pub local_host: String,
    pub local_port: u16,
    pub stop: Arc<AtomicBool>,
    /// Joined on stop/shutdown (best-effort).
    pub thread: Option<thread::JoinHandle<()>>,
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
///
/// `bound_addr` is the actual local address of the SOCKS5 listener, used in the
/// server reply to inform the client of the bound endpoint (RFC 1928 §6).
pub fn socks5_handshake(
    stream: &mut TcpStream,
    bound_addr: &std::net::SocketAddr,
) -> io::Result<(String, u16)> {
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
    if nmethods > 0 && !methods.contains(&0x00) {
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
        socks5_reply(stream, 0x07, bound_addr)?;
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
            socks5_reply(stream, 0x08, bound_addr)?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported SOCKS5 address type",
            ));
        }
    };

    socks5_reply(stream, 0x00, bound_addr)?;
    Ok((host, port))
}

fn socks5_reply(
    stream: &mut TcpStream,
    rep: u8,
    bound_addr: &std::net::SocketAddr,
) -> io::Result<()> {
    let mut resp = vec![0x05, rep, 0x00, 0x01];
    // Use the actual bound address; for error replies the caller may pass
    // a placeholder which is acceptable per RFC 1928.
    match bound_addr.ip() {
        std::net::IpAddr::V4(ipv4) => resp.extend_from_slice(&ipv4.octets()),
        std::net::IpAddr::V6(ipv6) => {
            resp[3] = 0x04; // ATYP = IPv6
            resp.extend_from_slice(&ipv6.octets());
        }
    }
    resp.extend_from_slice(&bound_addr.port().to_be_bytes());
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
///
/// Each accepted connection opens its **own** SSH connection via `factory` and
/// relays through it. Libssh2 sessions are not safe for concurrent use by
/// multiple threads, and the tunnel worker thread keeps polling the session it
/// owns — so sharing that session with relay threads would be a data race. A
/// dedicated connection per relay keeps every session single-threaded.
pub(crate) fn run_local_forward_loop(
    factory: crate::session_worker::SessionFactory,
    listener: TcpListener,
    remote_host: String,
    remote_port: u16,
    stop: Arc<AtomicBool>,
) {
    // Non-blocking + poll: `stop` is honored within one poll cycle without
    // relying on wake_listener reaching the bound port (which fails for
    // local_port=0 / 0.0.0.0 and would deadlock the join in stop_tunnel).
    let _ = listener.set_nonblocking(true);
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _peer)) => {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let f = factory.clone();
                let rh = remote_host.clone();
                let stop_c = Arc::clone(&stop);
                let _ = thread::Builder::new()
                    .name("tunnel-relay-local".into())
                    .spawn(move || {
                        match f.establish() {
                            Ok((sess, _hold)) => {
                                let _ = open_direct_tcpip_relay(
                                    &sess, &rh, remote_port, stream, &stop_c,
                                );
                            }
                            Err(e) => {
                                eprintln!("[tunnel-relay] establish failed: {e}");
                                let _ = stream.shutdown(Shutdown::Both);
                            }
                        }
                    });
            }
            Err(_) => {
                // WouldBlock (no pending connection) or transient error.
                // Never busy-spin: 50ms poll keeps stop latency snappy while
                // costing almost no CPU on idle tunnels.
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Dynamic SOCKS5 accept loop (dedicated SSH connection per relay, see
/// [`run_local_forward_loop`] for the threading rationale).
pub(crate) fn run_dynamic_forward_loop(
    factory: crate::session_worker::SessionFactory,
    listener: TcpListener,
    stop: Arc<AtomicBool>,
) {
    let bound_addr = listener.local_addr().ok();
    let _ = listener.set_nonblocking(true);
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((mut stream, _peer)) => {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let f = factory.clone();
                let stop_c = Arc::clone(&stop);
                let bound = bound_addr.unwrap_or_else(|| SocketAddr::from(([0, 0, 0, 0], 0)));
                let _ = thread::Builder::new()
                    .name("tunnel-relay-socks".into())
                    .spawn(move || {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                        match socks5_handshake(&mut stream, &bound) {
                            Ok((host, port)) => {
                                match f.establish() {
                                    Ok((sess, _hold)) => {
                                        let _ = open_direct_tcpip_relay(
                                            &sess, &host, port, stream, &stop_c,
                                        );
                                    }
                                    Err(e) => {
                                        eprintln!("[tunnel-relay] establish failed: {e}");
                                        let _ = stream.shutdown(Shutdown::Both);
                                    }
                                }
                            }
                            Err(_) => {
                                let _ = stream.shutdown(Shutdown::Both);
                            }
                        }
                    });
            }
            Err(_) => {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// Handle one remote-forwarded inbound channel: connect local and relay.
///
/// Must run on the thread that owns the channel's session (libssh2 sessions
/// are not safe for concurrent use).
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

/// Remote-forward loop on a dedicated thread owning its **own** authenticated
/// SSH connection (established via `factory`).
///
/// Accept and relay run sequentially on this single thread: the session is
/// never shared with the tunnel worker thread (which keeps polling its own
/// session), eliminating the previous cross-thread data race. One inbound
/// connection is serviced at a time — acceptable for remote forwards and far
/// better than racing the session.
///
/// Failures to establish the dedicated session or to start `channel_forward_listen`
/// are pushed as a `TunnelStatus(Error)` event (in addition to stderr logging) so
/// the UI does not keep showing the tunnel as `Running` when it never came up.
pub(crate) fn run_remote_forward_loop(
    factory: crate::session_worker::SessionFactory,
    session_id: Uuid,
    config: TunnelConfig,
    event_tx: flume::Sender<SessionEvent>,
    stop: Arc<AtomicBool>,
) {
    let (remote_host, remote_port, local_host, local_port) = match &config.kind {
        TunnelType::Remote {
            remote_host,
            remote_port,
            local_host,
            local_port,
        } => (
            remote_host.clone(),
            *remote_port,
            local_host.clone(),
            *local_port,
        ),
        _ => {
            eprintln!("[tunnel-remote] not a remote config; exiting");
            return;
        }
    };

    let report_error = |msg: String| {
        let _ = event_tx.send(SessionEvent::TunnelStatus(TunnelStatus {
            tunnel_id: config.id,
            session_id,
            name: config.name.clone(),
            kind: config.kind.clone(),
            auto_start: config.auto_start,
            state: "error".into(),
            error: Some(msg),
        }));
    };

    let (sess, _hold) = match factory.establish() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tunnel-remote] establish failed: {e}");
            report_error(format!("远端转发建立连接失败：{e}"));
            return;
        }
    };

    sess.set_blocking(true);
    let (mut listener, _bound) = match sess.channel_forward_listen(
        remote_port,
        Some(remote_host.as_str()),
        Some(16),
    ) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tunnel-remote] forward listen failed: {e}");
            report_error(format!("远端转发监听失败：{e}"));
            return;
        }
    };
    // 1ms poll so `stop` is honored promptly (accept returns on timeout).
    sess.set_timeout(1);

    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok(channel) => {
                handle_remote_inbound(channel, &local_host, local_port, &stop);
            }
            Err(_) => {
                // Timeout / transient error — loop again to check stop.
            }
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
        let bound = addr;
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            socks5_handshake(&mut stream, &bound).unwrap()
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
        let bound = addr;
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            socks5_handshake(&mut stream, &bound).unwrap()
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
