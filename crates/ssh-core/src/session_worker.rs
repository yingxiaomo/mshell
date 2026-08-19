//! Session worker thread: one OS thread per live SSH/Telnet/Serial/Local session.
//!
//! Each worker owns an `ssh2::Session` (or protocol wrapper), runs a command
//! loop over a [`flume`] receiver, and pushes events (output, disconnect,
//! transfer progress, tunnel status) to a shared sender.
//!
//! # Thread safety
//!
//! `ssh2::Session` is `Sync` (internally `Arc`+mutex) but **not** `Send`.
//! By keeping it on one OS thread and sending commands over a channel we
//! avoid the `Send` requirement entirely.

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use protocol::{
    Connection, SerialConfig, TunnelConfig, TunnelStatus,
    TunnelType,
};
use ssh2::{Channel, Session, Sftp};
use uuid::Uuid;

use crate::auth;
use crate::error::CoreError;
use crate::host_key::{self, KnownHostsPolicy};
use crate::sftp as sftp_ops;
use crate::terminal;
use crate::transfer::TransferQueue;
use crate::tunnel::{
    self, LocalTunnelHandle, RemoteTunnelHandle, TunnelRuntimeInfo, TunnelState,
};

use crate::session::{SessionCmd, SessionEvent};

// ============================================================================
// Supporting types
// ============================================================================

/// Keeps intermediate jump sessions and localhost relay threads alive for the
/// lifetime of the target session. Relays are stopped on drop.
pub(crate) struct JumpHold {
    /// Bastion sessions (must outlive relays that clone them).
    hop_sessions: Vec<Session>,
    stop_flags: Vec<Arc<AtomicBool>>,
    relays: Vec<Option<JoinHandle<()>>>,
}

impl Drop for JumpHold {
    fn drop(&mut self) {
        for f in &self.stop_flags {
            f.store(true, Ordering::Relaxed);
        }
        // Wake blocked accept/relay by connecting to nothing — relays exit on channel EOF
        // when hop sessions drop. Join best-effort.
        for t in &mut self.relays {
            if let Some(h) = t.take() {
                let _ = h.join();
            }
        }
        self.hop_sessions.clear();
    }
}

struct ShellChannelPair {
    channel: Channel,
    /// Bytes queued for stdin that couldn't be written yet (send window full).
    /// Flushed on each poll tick so pasted/large input is never silently dropped
    /// when the remote's window briefly fills (M8).
    pending_input: Vec<u8>,
}

/// An in-flight exec command being polled asynchronously alongside I/O.
struct PendingExec {
    channel: Channel,
    output: Vec<u8>,
    reply: flume::Sender<Result<String, CoreError>>,
    started: Instant,
}

/// Wall-clock cap for a single `exec` before it is force-closed with an error,
/// so a non-terminating command (e.g. `tail -f`) cannot hang the caller forever.
const EXEC_TIMEOUT: Duration = Duration::from_secs(60);

/// Upper bound on accumulated exec output (stdout+stderr) before aborting, so a
/// high-volume command cannot grow memory without limit.
const EXEC_MAX_OUTPUT: usize = 16 * 1024 * 1024;

/// SSH keepalive interval (s). Must match `keepalive_config(15, _)` set in
/// [`establish_session_on_tcp`]; the throttle here skips per-tick calls.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

// ============================================================================
// Top-level worker entry points (called via thread::spawn)
// ============================================================================

#[allow(clippy::too_many_arguments)]
pub(crate) fn session_worker(
    session_id: Uuid,
    conn: Connection,
    chain: Vec<Connection>,
    policy: KnownHostsPolicy,
    known_hosts_path: PathBuf,
    timeout: Duration,
    ready_tx: flume::Sender<Result<(), CoreError>>,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
    transfers: Arc<TransferQueue>,
) {
    match establish_session_chain(&chain, policy, &known_hosts_path, timeout) {
        Ok((sess, hold)) => {
            let _ = ready_tx.send(Ok(()));
            drop(ready_tx);
            // Factory lets the worker lazily establish *separate* authenticated
            // sessions (own TCP connection) for SFTP and tunnels, so blocking
            // transfers and tunnel blocking-mode toggles never freeze or race the
            // interactive terminal session.
            let factory = SessionFactory {
                chain,
                policy,
                known_hosts_path,
                timeout,
            };
            let reason = run_cmd_loop(session_id, sess, factory, cmd_rx, event_tx.clone(), transfers);
            // Drop hold after target session ends (stops relays / bastions).
            drop(hold);
            let _ = conn;
            let _ = event_tx.send(SessionEvent::Disconnected {
                session_id,
                reason,
            });
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    }
}

/// Inputs needed to (re)establish a fully-authenticated session for the same
/// endpoint — used to give SFTP and tunnels their own isolated connections.
#[derive(Clone)]
pub(crate) struct SessionFactory {
    pub(crate) chain: Vec<Connection>,
    pub(crate) policy: KnownHostsPolicy,
    pub(crate) known_hosts_path: PathBuf,
    pub(crate) timeout: Duration,
}

impl SessionFactory {
    pub(crate) fn establish(&self) -> Result<(Session, JumpHold), CoreError> {
        establish_session_chain(&self.chain, self.policy, &self.known_hosts_path, self.timeout)
    }

    /// Establish with a few retries. The interactive session opens first, then
    /// SFTP/tunnel open their own connections moments later; some servers
    /// rate-limit rapid successive connects (handshake timeout), so retry.
    fn establish_retry(&self, attempts: u32) -> Result<(Session, JumpHold), CoreError> {
        let mut last: Option<CoreError> = None;
        for i in 0..attempts.max(1) {
            match self.establish() {
                Ok(v) => return Ok(v),
                Err(e) => {
                    last = Some(e);
                    if i + 1 < attempts {
                        std::thread::sleep(Duration::from_millis(600));
                    }
                }
            }
        }
        Err(last.unwrap_or_else(|| CoreError::Other("establish failed".into())))
    }
}

/// A lazily-spawned worker thread owning its own SSH session (SFTP or tunnels).
struct SubWorker {
    tx: flume::Sender<SessionCmd>,
    handle: Option<JoinHandle<()>>,
}

impl SubWorker {
    /// Signal shutdown and join. Caller should cancel in-flight transfers first.
    fn shutdown(mut self) {
        let _ = self.tx.send(SessionCmd::Shutdown);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn telnet_session_worker(
    session_id: Uuid,
    host: String,
    port: u16,
    timeout: Duration,
    ready_tx: flume::Sender<Result<(), CoreError>>,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
    _transfers: Arc<TransferQueue>,
) {
    match crate::telnet::TelnetSession::connect(&host, port, timeout) {
        Ok(mut telnet) => {
            let _ = ready_tx.send(Ok(()));
            drop(ready_tx);
            let reason = run_telnet_cmd_loop(session_id, &mut telnet, cmd_rx, event_tx.clone());
            let _ = telnet.close();
            let _ = event_tx.send(SessionEvent::Disconnected {
                session_id,
                reason,
            });
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn local_session_worker(
    session_id: Uuid,
    _timeout: Duration,
    ready_tx: flume::Sender<Result<(), CoreError>>,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
    _transfers: Arc<TransferQueue>,
) {
    match crate::local::LocalSession::spawn(80, 24) {
        Ok(mut local) => {
            let _ = ready_tx.send(Ok(()));
            drop(ready_tx);
            let reason = run_local_cmd_loop(session_id, &mut local, cmd_rx, event_tx.clone());
            let _ = local.kill();
            let _ = event_tx.send(SessionEvent::Disconnected {
                session_id,
                reason,
            });
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn serial_session_worker(
    session_id: Uuid,
    config: SerialConfig,
    timeout: Duration,
    ready_tx: flume::Sender<Result<(), CoreError>>,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
    _transfers: Arc<TransferQueue>,
) {
    match crate::serial::SerialSession::open(&config, timeout) {
        Ok(mut serial) => {
            let _ = ready_tx.send(Ok(()));
            drop(ready_tx);
            let reason = run_serial_cmd_loop(session_id, &mut serial, cmd_rx, event_tx.clone());
            let _ = serial.close();
            let _ = event_tx.send(SessionEvent::Disconnected {
                session_id,
                reason,
            });
        }
        Err(e) => {
            let _ = ready_tx.send(Err(e));
        }
    }
}

// ============================================================================
// Protocol-specific command loops
// ============================================================================

fn run_telnet_cmd_loop(
    session_id: Uuid,
    telnet: &mut crate::telnet::TelnetSession,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
) -> String {
    let _ = telnet.set_nonblocking(false);
    let mut read_buf = [0u8; 32 * 1024];
    let poll = Duration::from_millis(15);

    loop {
        match cmd_rx.recv_timeout(poll) {
            Ok(cmd) => match cmd {
                SessionCmd::Write { data, .. } => {
                    let _ = telnet.write(&data);
                }
                SessionCmd::Resize { .. } => {}
                SessionCmd::OpenShell { .. } => {}
                SessionCmd::Shutdown => return "shutdown".into(),
                _ => {}
            },
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => return "channel closed".into(),
        }

        match telnet.try_read(&mut read_buf) {
            Ok(Some(0)) => return "remote closed".into(),
            Ok(Some(n)) => {
                let _ = event_tx.send(SessionEvent::Output {
                    session_id,
                    channel_id: session_id,
                    data: read_buf[..n].to_vec(),
                });
            }
            Ok(None) => {}
            Err(e) => {
                let msg = e.to_string();
                let _ = event_tx
                    .send(SessionEvent::Disconnected { session_id, reason: msg.clone() });
                return msg;
            }
        }
    }
}

fn run_local_cmd_loop(
    session_id: Uuid,
    local: &mut crate::local::LocalSession,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
) -> String {
    let _ = local.set_nonblocking();
    let mut read_buf = [0u8; 32 * 1024];
    let poll = Duration::from_millis(15);

    loop {
        match cmd_rx.recv_timeout(poll) {
            Ok(cmd) => match cmd {
                SessionCmd::Write { data, .. } => {
                    let _ = local.write(&data);
                }
                SessionCmd::Resize { .. } => {}
                SessionCmd::OpenShell { .. } => {}
                SessionCmd::Shutdown => return "shutdown".into(),
                _ => {}
            },
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => return "channel closed".into(),
        }

        match local.try_read(&mut read_buf) {
            Ok(Some(0)) => return "process exited".into(),
            Ok(Some(n)) => {
                let _ = event_tx.send(SessionEvent::Output {
                    session_id,
                    channel_id: session_id,
                    data: read_buf[..n].to_vec(),
                });
            }
            Ok(None) => {}
            Err(e) => {
                let msg = e.to_string();
                let _ = event_tx
                    .send(SessionEvent::Disconnected { session_id, reason: msg.clone() });
                return msg;
            }
        }
    }
}

fn run_serial_cmd_loop(
    session_id: Uuid,
    serial: &mut crate::serial::SerialSession,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
) -> String {
    let mut read_buf = [0u8; 32 * 1024];
    let poll = Duration::from_millis(15);

    loop {
        match cmd_rx.recv_timeout(poll) {
            Ok(cmd) => match cmd {
                SessionCmd::Write { data, .. } => {
                    let _ = serial.write(&data);
                }
                SessionCmd::Resize { .. } => {}
                SessionCmd::OpenShell { .. } => {}
                SessionCmd::Shutdown => return "shutdown".into(),
                _ => {}
            },
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => return "channel closed".into(),
        }

        match serial.try_read(&mut read_buf) {
            Ok(Some(0)) => return "serial closed".into(),
            Ok(Some(n)) => {
                let _ = event_tx.send(SessionEvent::Output {
                    session_id,
                    channel_id: session_id,
                    data: read_buf[..n].to_vec(),
                });
            }
            Ok(None) => {}
            Err(e) => {
                let msg = e.to_string();
                let _ = event_tx
                    .send(SessionEvent::Disconnected { session_id, reason: msg.clone() });
                return msg;
            }
        }
    }
}

// ============================================================================
// SSH connection chain helpers
// ============================================================================

/// Establish SSH, possibly through ProxyJump hops.
///
/// `chain` is `[outermost_jump, …, target]` (len ≥ 1). Intermediate hops open a
/// local 127.0.0.1 relay into `channel_direct_tcpip` toward the next hop; the
/// final hop handshakes on that TCP stream (or direct TCP when len == 1).
fn establish_session_chain(
    chain: &[Connection],
    policy: KnownHostsPolicy,
    known_hosts_path: &std::path::Path,
    timeout: Duration,
) -> Result<(Session, JumpHold), CoreError> {
    if chain.is_empty() {
        return Err(CoreError::Other("empty jump chain".into()));
    }
    if chain.len() == 1 {
        let sess = establish_session_on_tcp(
            &chain[0],
            tcp_connect_host(&chain[0].host, chain[0].port, timeout)?,
            policy,
            known_hosts_path,
        )?;
        return Ok((
            sess,
            JumpHold {
                hop_sessions: vec![],
                stop_flags: vec![],
                relays: vec![],
            },
        ));
    }

    let mut hold = JumpHold {
        hop_sessions: Vec::new(),
        stop_flags: Vec::new(),
        relays: Vec::new(),
    };

    // First hop: direct TCP to outermost bastion.
    let mut current = establish_session_on_tcp(
        &chain[0],
        tcp_connect_host(&chain[0].host, chain[0].port, timeout)?,
        policy,
        known_hosts_path,
    )?;

    for i in 0..chain.len() - 1 {
        let next = &chain[i + 1];
        let (stream, stop, relay) =
            open_local_relay_to(&current, &next.host, next.port, timeout)?;
        hold.stop_flags.push(stop);
        hold.relays.push(Some(relay));
        hold.hop_sessions.push(current);
        current = establish_session_on_tcp(next, stream, policy, known_hosts_path)?;
    }

    Ok((current, hold))
}

fn tcp_connect_host(host: &str, port: u16, timeout: Duration) -> Result<TcpStream, CoreError> {
    // Reject an empty host explicitly. Otherwise `("", port)` resolution is
    // platform-dependent (some OSes map it to loopback / 0.0.0.0 and connect
    // succeeds), which is both wrong and non-deterministic in tests.
    if host.trim().is_empty() {
        return Err(CoreError::Other("主机地址不能为空".into()));
    }
    let addr = format!("{host}:{port}");
    let tcp = match addr.parse::<std::net::SocketAddr>() {
        Ok(sa) => TcpStream::connect_timeout(&sa, timeout)?,
        Err(_) => {
            // Hostname — resolve + connect with timeout to avoid hanging on DNS / TCP.
            let addrs = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
                .map_err(|e| CoreError::Other(format!("DNS 解析失败（{host}:{port}）：{e}")))?;
            let mut last_err = None;
            for sa in addrs {
                match TcpStream::connect_timeout(&sa, timeout) {
                    Ok(s) => {
                        let _ = s.set_read_timeout(Some(timeout));
                        let _ = s.set_write_timeout(Some(timeout));
                        return Ok(s);
                    }
                    Err(e) => last_err = Some(e),
                }
            }
            return Err(CoreError::Io(last_err.unwrap_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotConnected, "所有地址均连接失败")
            })));
        }
    };
    let _ = tcp.set_read_timeout(Some(timeout));
    let _ = tcp.set_write_timeout(Some(timeout));
    Ok(tcp)
}

/// Bind 127.0.0.1:0; spawn a relay that accepts one TCP client and bridges it
/// through `bastion.channel_direct_tcpip(remote_host, remote_port)`.
fn open_local_relay_to(
    bastion: &Session,
    remote_host: &str,
    remote_port: u16,
    timeout: Duration,
) -> Result<(TcpStream, Arc<AtomicBool>, JoinHandle<()>), CoreError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(CoreError::Io)?;
    let local_addr = listener.local_addr().map_err(CoreError::Io)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_c = Arc::clone(&stop);

    let bastion = bastion.clone();
    let rh = remote_host.to_string();
    let rp = remote_port;
    let handle = thread::Builder::new()
        .name("proxyjump-relay".into())
        .spawn(move || {
            // Poll-accept so `stop` is honored even before any client connects:
            // if the caller's connect fails, the thread exits promptly instead of
            // leaking a blocked accept() forever.
            loop {
                if stop_c.load(Ordering::Relaxed) {
                    return;
                }
                let _ = listener.set_nonblocking(true);
                match listener.accept() {
                    Ok((client, _)) => {
                        if stop_c.load(Ordering::Relaxed) {
                            let _ = client.shutdown(std::net::Shutdown::Both);
                            return;
                        }
                        let _ = client.set_read_timeout(Some(timeout));
                        let _ = client.set_write_timeout(Some(timeout));

                        bastion.set_blocking(true);
                        let channel = bastion.channel_direct_tcpip(&rh, rp, Some(("127.0.0.1", 0)));
                        bastion.set_blocking(false);
                        let Ok(channel) = channel else {
                            let _ = client.shutdown(std::net::Shutdown::Both);
                            return;
                        };
                        // Reuse tunnel relay (poll loop; works with mixed blocking modes).
                        tunnel::relay_bidirectional(client, channel, &stop_c);
                        return;
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => return,
                }
            }
        })
        .map_err(|e| CoreError::Other(format!("spawn jump relay: {e}")))?;

    let stream = match TcpStream::connect_timeout(&local_addr, timeout) {
        Ok(s) => s,
        Err(e) => {
            // Connect failed (e.g. timeout): stop the polling relay thread so it
            // doesn't leak waiting on accept() for the lifetime of the process.
            stop.store(true, Ordering::Relaxed);
            return Err(CoreError::Io(e));
        }
    };
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    Ok((stream, stop, handle))
}

/// Handshake + host-key + auth on an existing TCP stream.
fn establish_session_on_tcp(
    conn: &Connection,
    tcp: TcpStream,
    policy: KnownHostsPolicy,
    known_hosts_path: &std::path::Path,
) -> Result<Session, CoreError> {
    let mut sess = Session::new().map_err(CoreError::from)?;

    // ── Timeouts ────────────────────────────────────────────────────────
    // libssh2 has its own internal timeout that MUST be set separately from
    // the TCP socket timeout.  Without this, sess.handshake() can block
    // forever if the remote accepts TCP but never responds to SSH KEX init.
    sess.set_timeout(30_000); // libssh2 internal timeout (ms)
    // Enable keepalives for real: libssh2's `keepalive_send()` only transmits a
    // packet once the configured interval elapses — with no `set_keepalive`
    // call it is a no-op and NAT/server idle timeouts silently drop the
    // connection. 15s keeps well under typical NAT limits.
    sess.set_keepalive(true, 15);
    let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
    sess.set_tcp_stream(tcp);

    // ── Diagnostics ─────────────────────────────────────────────────────
    // Log locally compiled algorithms for debugging handshake failures.
    if let Ok(algs) = sess.supported_algs(ssh2::MethodType::Kex) {
        eprintln!("[ssh-core] local KEX: {algs:?}");
    }
    if let Ok(algs) = sess.supported_algs(ssh2::MethodType::HostKey) {
        eprintln!("[ssh-core] local hostkey: {algs:?}");
    }

    if let Err(e) = sess.handshake() {
        let err_msg = e.message();
        let err_code = e.code();
        let active_kex = sess
            .methods(ssh2::MethodType::Kex)
            .unwrap_or("(none)");
        let active_hostkey = sess
            .methods(ssh2::MethodType::HostKey)
            .unwrap_or("(none)");
        eprintln!(
            "[ssh-core] handshake failed: \
             code={err_code:?} msg={err_msg:?} host={}:{} \
             final_kex={active_kex} final_hostkey={active_hostkey}",
            conn.host, conn.port,
        );
        return Err(CoreError::Other(format!(
            "SSH 握手失败：{err_msg}（错误码 {err_code:?})",
        )));
    }

    let (key_bytes, key_type) = sess
        .host_key()
        .ok_or_else(|| CoreError::Other("server presented no host key".into()))?;
    let key_type_str = format!("{key_type:?}");
    host_key::verify_host_key(
        known_hosts_path,
        &conn.host,
        conn.port,
        key_bytes,
        &key_type_str,
        policy,
    )?;

    auth::authenticate(&sess, conn)?;
    Ok(sess)
}

// ============================================================================
// SSH command loop (the main event loop for SSH sessions)
// ============================================================================

#[allow(clippy::too_many_arguments)]
fn run_cmd_loop(
    session_id: Uuid,
    mut sess: Session,
    factory: SessionFactory,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
    transfers: Arc<TransferQueue>,
) -> String {
    let mut channels: HashMap<Uuid, ShellChannelPair> = HashMap::new();
    let mut pending_execs: Vec<PendingExec> = Vec::new();
    // The interactive session stays permanently non-blocking and is touched only
    // by this thread. SFTP and tunnels run on their own separately-authenticated
    // sessions (see SessionFactory) so blocking transfers and tunnel blocking-mode
    // toggles can never freeze or race the terminal.
    sess.set_blocking(false);

    // Lazily-spawned secondary workers (each owns its own session + thread).
    let mut sftp_worker: Option<SubWorker> = None;
    let mut tunnel_worker: Option<SubWorker> = None;
    // Session-scoped transfer cancel flags so Shutdown aborts an in-flight copy
    // promptly instead of blocking disconnect for the whole transfer.
    let mut transfer_cancels: HashMap<Uuid, Arc<AtomicBool>> = HashMap::new();

    let mut read_buf = [0u8; 32 * 1024];
    let poll = Duration::from_millis(15);
    // Once a shell channel has existed, an empty channel map means the shell
    // closed (user `exit`, server drop) → the session is finished.
    let mut had_channel = false;
    let mut last_keepalive = Instant::now();

    let reason: String = 'outer: loop {
        // --- drain pending commands (short wait, then non-blocking) ---
        match cmd_rx.recv_timeout(poll) {
            Ok(cmd) => {
                if let Some(r) = route_cmd(
                    cmd, &mut sess, session_id, &factory, &mut channels, &mut pending_execs,
                    &mut sftp_worker, &mut tunnel_worker, &mut transfer_cancels,
                    &event_tx, &transfers, &mut had_channel,
                ) {
                    break 'outer r;
                }
            }
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => {
                break 'outer "command channel closed".into();
            }
        }

        // Drain any additional queued commands without waiting.
        while let Ok(cmd) = cmd_rx.try_recv() {
            if let Some(r) = route_cmd(
                cmd, &mut sess, session_id, &factory, &mut channels, &mut pending_execs,
                &mut sftp_worker, &mut tunnel_worker, &mut transfer_cancels,
                &event_tx, &transfers, &mut had_channel,
            ) {
                break 'outer r;
            }
        }

        // --- poll channel I/O ---
        // Keepalive is throttled: libssh2 only transmits when the configured
        // interval (15s) has elapsed, but skip the per-tick call anyway to avoid
        // useless repeated checks on busy sessions.
        if last_keepalive.elapsed() >= KEEPALIVE_INTERVAL {
            let _ = sess.keepalive_send();
            last_keepalive = Instant::now();
        }

        let mut closed: Vec<Uuid> = Vec::new();
        for (channel_id, pair) in channels.iter_mut() {
            let mut reads_this_cycle: u32 = 0;
            // Coalesce every read this cycle into ONE event, so the frontend does
            // a single base64 decode + xterm write per channel per tick instead of
            // up to 8 — cuts IPC/encoding overhead on high-throughput output.
            let mut acc: Vec<u8> = Vec::new();

            // stdout
            loop {
                if reads_this_cycle >= 4 {
                    break;
                }
                match terminal::try_read(&mut pair.channel, &mut read_buf) {
                    Ok(Some(0)) => {
                        closed.push(*channel_id);
                        break;
                    }
                    Ok(Some(n)) => {
                        reads_this_cycle += 1;
                        acc.extend_from_slice(&read_buf[..n]);
                    }
                    Ok(None) => break,
                    Err(_) => {
                        closed.push(*channel_id);
                        break;
                    }
                }
            }

            // stderr (merged into same terminal stream)
            loop {
                if reads_this_cycle >= 8 {
                    break;
                }
                match terminal::try_read_stderr(&mut pair.channel, &mut read_buf) {
                    Ok(Some(0)) | Ok(None) => break,
                    Ok(Some(n)) => {
                        reads_this_cycle += 1;
                        acc.extend_from_slice(&read_buf[..n]);
                    }
                    Err(_) => break,
                }
            }

            if !acc.is_empty() {
                let _ = event_tx.send(SessionEvent::Output {
                    session_id,
                    channel_id: *channel_id,
                    data: acc,
                });
            }

            // Flush queued stdin bytes (pastes / large input blocked by a full
            // remote send window on a previous tick).
            flush_pending_input(pair);

            if pair.channel.eof() {
                closed.push(*channel_id);
            }
        }

        for id in closed {
            if let Some(mut pair) = channels.remove(&id) {
                let _ = pair.channel.close();
                let _ = pair.channel.wait_close();
            }
        }

        // Shell closed → end the session so the worker doesn't spin forever and
        // the UI receives a Disconnected event.
        if had_channel && channels.is_empty() {
            break 'outer "session closed".into();
        }

        // --- poll pending exec channels (timeout / output cap / stderr) ---
        poll_pending_execs(&mut pending_execs, &mut read_buf);
    };

    // --- teardown: abort transfers, then stop sub-workers ---
    for flag in transfer_cancels.values() {
        flag.store(true, Ordering::SeqCst);
    }
    if let Some(w) = sftp_worker {
        w.shutdown();
    }
    if let Some(w) = tunnel_worker {
        w.shutdown();
    }

    reason
}

/// Route one command: interactive commands (shell / exec) run on this thread;
/// SFTP and tunnel commands are forwarded to their dedicated sub-workers, which
/// are spawned on first use. Returns `Some(reason)` when the worker should exit.
#[allow(clippy::too_many_arguments)]
fn route_cmd(
    cmd: SessionCmd,
    sess: &mut Session,
    session_id: Uuid,
    factory: &SessionFactory,
    channels: &mut HashMap<Uuid, ShellChannelPair>,
    pending_execs: &mut Vec<PendingExec>,
    sftp_worker: &mut Option<SubWorker>,
    tunnel_worker: &mut Option<SubWorker>,
    transfer_cancels: &mut HashMap<Uuid, Arc<AtomicBool>>,
    event_tx: &flume::Sender<SessionEvent>,
    transfers: &Arc<TransferQueue>,
    had_channel: &mut bool,
) -> Option<String> {
    if is_sftp_cmd(&cmd) {
        // Track transfer cancel flags so shutdown can abort an in-flight copy.
        match &cmd {
            SessionCmd::SftpUpload { transfer_id, cancel, .. }
            | SessionCmd::SftpDownload { transfer_id, cancel, .. } => {
                transfer_cancels.insert(*transfer_id, Arc::clone(cancel));
            }
            _ => {}
        }
        // Drop flags for transfers that already finished (avoids unbounded
        // growth for long-lived sessions with many sequential transfers).
        transfer_cancels.retain(|id, _| transfers.is_tracked(*id));
        let tx = ensure_sftp_worker(sftp_worker, factory, session_id, event_tx, transfers);
        match tx.send(cmd) {
            Ok(()) => {}
            Err(flume::SendError(cmd)) => {
                let err = CoreError::Other("SFTP 子线程已退出，命令未能投递".into());
                // Failed to queue: reply the error + emit failed transfer event so
                // callers don't hang forever (worker dead or never spawned).
                fail_sftp_command(
                    cmd,
                    &err,
                    session_id,
                    event_tx.clone(),
                    transfers,
                );
            }
        }
        return None;
    }
    if is_tunnel_cmd(&cmd) {
        let tx = ensure_tunnel_worker(tunnel_worker, factory, session_id, event_tx);
        match tx.send(cmd) {
            Ok(()) => {}
            Err(flume::SendError(cmd)) => {
                let err = CoreError::Other("隧道子线程已退出，命令未能投递".into());
                fail_sftp_command(cmd, &err, session_id, event_tx.clone(), transfers);
            }
        }
        return None;
    }

    match cmd {
        SessionCmd::Shutdown => return Some("shutdown".into()),
        SessionCmd::OpenShell { cols, rows, reply } => {
            sess.set_blocking(true);
            let result = terminal::open_shell(sess, cols, rows);
            sess.set_blocking(false);
            match result {
                Ok((channel_id, channel)) => {
                    channels.insert(
                        channel_id,
                        ShellChannelPair {
                            channel,
                            pending_input: Vec::new(),
                        },
                    );
                    *had_channel = true;
                    let _ = reply.send(Ok(channel_id));
                }
                Err(e) => {
                    let _ = reply.send(Err(e));
                }
            }
        }
        SessionCmd::Write { channel_id, data } => {
            if let Some(pair) = channels.get_mut(&channel_id) {
                // Prepend the new bytes to any still-queued input and write as
                // much as the window allows; the remainder is flushed on later
                // poll ticks (never silently dropped).
                pair.pending_input.extend_from_slice(&data);
                flush_pending_input(pair);
            }
        }
        SessionCmd::Resize { channel_id, cols, rows } => {
            if let Some(pair) = channels.get_mut(&channel_id) {
                sess.set_blocking(true);
                let _ = terminal::resize(&mut pair.channel, cols, rows);
                sess.set_blocking(false);
            }
        }
        c @ SessionCmd::Exec { .. } => dispatch_exec(sess, c, pending_execs),
        _ => {}
    }
    None
}

fn is_sftp_cmd(cmd: &SessionCmd) -> bool {
    matches!(
        cmd,
        SessionCmd::OpenSftp { .. }
            | SessionCmd::SftpList { .. }
            | SessionCmd::SftpMkdir { .. }
            | SessionCmd::SftpRm { .. }
            | SessionCmd::SftpRename { .. }
            | SessionCmd::SftpChmod { .. }
            | SessionCmd::SftpRealpath { .. }
            | SessionCmd::SftpUpload { .. }
            | SessionCmd::SftpDownload { .. }
            | SessionCmd::SftpRead { .. }
            | SessionCmd::SftpWrite { .. }
    )
}

fn is_tunnel_cmd(cmd: &SessionCmd) -> bool {
    matches!(
        cmd,
        SessionCmd::TunnelStart { .. } | SessionCmd::TunnelStop { .. } | SessionCmd::TunnelList { .. }
    )
}

/// Spawn (once) the SFTP sub-worker and return its command sender. The worker
/// establishes its own authenticated session on its own thread, so the first
/// SFTP op does not block the terminal during the SFTP session handshake.
fn ensure_sftp_worker(
    slot: &mut Option<SubWorker>,
    factory: &SessionFactory,
    session_id: Uuid,
    event_tx: &flume::Sender<SessionEvent>,
    transfers: &Arc<TransferQueue>,
) -> flume::Sender<SessionCmd> {
    if let Some(w) = slot {
        // Slot was previously poisoned by a failed spawn → retry once.
        if w.handle.is_some() {
            return w.tx.clone();
        }
    }
    let (tx, rx) = flume::unbounded::<SessionCmd>();
    let factory = factory.clone();
    let ev = event_tx.clone();
    let transfers = Arc::clone(transfers);
    match thread::Builder::new()
        .name(format!("sftp-session-{session_id}"))
        .spawn(move || sftp_worker_loop(session_id, factory, rx, ev, transfers))
    {
        Ok(handle) => {
            let tx_out = tx.clone();
            *slot = Some(SubWorker {
                tx,
                handle: Some(handle),
            });
            tx_out
        }
        // Thread spawn failed (exhausted resources): keep the slot unset so the
        // next command retries instead of being stuck on a dead worker forever.
        Err(_) => tx,
    }
}

/// Spawn (once) the tunnel sub-worker and return its command sender.
fn ensure_tunnel_worker(
    slot: &mut Option<SubWorker>,
    factory: &SessionFactory,
    session_id: Uuid,
    event_tx: &flume::Sender<SessionEvent>,
) -> flume::Sender<SessionCmd> {
    if let Some(w) = slot {
        // Slot was previously poisoned by a failed spawn → retry once.
        if w.handle.is_some() {
            return w.tx.clone();
        }
    }
    let (tx, rx) = flume::unbounded::<SessionCmd>();
    let factory = factory.clone();
    let ev = event_tx.clone();
    match thread::Builder::new()
        .name(format!("tunnel-session-{session_id}"))
        .spawn(move || tunnel_worker_loop(session_id, factory, rx, ev))
    {
        Ok(handle) => {
            let tx_out = tx.clone();
            *slot = Some(SubWorker {
                tx,
                handle: Some(handle),
            });
            tx_out
        }
        // Thread spawn failed: keep the slot unset so the next command retries.
        Err(_) => tx,
    }
}

/// SFTP sub-worker: owns a dedicated blocking SSH session; runs all SFTP ops
/// (including chunked transfers) so they never stall the interactive terminal.
fn sftp_worker_loop(
    session_id: Uuid,
    factory: SessionFactory,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
    transfers: Arc<TransferQueue>,
) {
    // The session is (re)established lazily. Unlike the interactive worker, this
    // one blocks waiting for commands and generates no traffic while idle — so it
    // must send keepalives, or NAT/server idle timeouts silently drop the
    // connection and the next op fails with "Unable to send FXP_*".
    let mut conn: Option<(Session, JumpHold)> = None;
    let mut sftp: Option<Sftp> = None;
    // Keep well under typical NAT/idle timeouts.
    let idle = Duration::from_secs(15);
    let mut last_activity = Instant::now();

    loop {
        match cmd_rx.recv_timeout(idle) {
            Ok(SessionCmd::Shutdown) => break,
            Ok(cmd) => {
                // After an idle gap, probe the session with a cheap round trip and
                // transparently reconnect if it died — so a dropped connection
                // never surfaces a stale "Unable to send FXP_*" error to the user.
                if conn.is_some()
                    && last_activity.elapsed() > Duration::from_secs(5)
                    && !sftp_session_alive(&conn, &sftp)
                {
                    conn = None;
                    sftp = None;
                }
                if conn.is_none() {
                    match factory.establish_retry(3) {
                        Ok((s, h)) => {
                            s.set_blocking(true);
                            conn = Some((s, h));
                            sftp = None;
                        }
                        Err(e) => {
                            eprintln!("[sftp-session] establish failed: {e}");
                            // Reply with the error instead of silently dropping
                            // the command, and emit a failed event + finish for
                            // transfers so their state doesn't linger as running.
                            // Only the SFTP sub-worker thread touches `cmd`, so
                            // it is safe to consume it here.
                            fail_sftp_command(cmd, &e, session_id, event_tx.clone(), &transfers);
                            continue;
                        }
                    }
                }
                if let Some(sess) = conn.as_mut().map(|(s, _)| s) {
                    handle_sftp_cmd(sess, session_id, cmd, &mut sftp, &event_tx, &transfers);
                } else {
                    eprintln!("[sftp-session] unexpected: conn is None after establish");
                    // Dropping the command's reply channel surfaces the error.
                }
                last_activity = Instant::now();
            }
            Err(flume::RecvTimeoutError::Timeout) => {
                // Idle keepalive. If it fails the connection is dead — drop it so
                // the next command transparently re-establishes a fresh session.
                if let Some((sess, _)) = conn.as_ref() {
                    if sess.keepalive_send().is_err() {
                        conn = None;
                        sftp = None;
                    }
                }
            }
            Err(flume::RecvTimeoutError::Disconnected) => break,
        }
    }
    // `conn` (Session + JumpHold) drops here.
}

/// Reply to every SFTP command channel with `err` so callers never hang on a
/// lost command, and emit a failure event + finish for transfer commands (their
/// state must not linger as "running" when the SFTP connection cannot be
/// established). Consumes `cmd` — only ever called on the SFTP worker thread.
fn fail_sftp_command(
    cmd: SessionCmd,
    err: &CoreError,
    session_id: Uuid,
    event_tx: flume::Sender<SessionEvent>,
    transfers: &TransferQueue,
) {
    // CoreError isn't Clone (keyring::Error isn't), so rebuild an equivalent
    // error for each reply channel.
    let fail = CoreError::Other(err.to_string());
    match cmd {
        SessionCmd::OpenSftp { reply } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpList { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpMkdir { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpRm { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpRename { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpChmod { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpRealpath { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpUpload {
            transfer_id, reply, ..
        } => {
            transfers.finish(transfer_id);
            emit_transfer_failed(&event_tx, session_id, transfer_id, err);
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpDownload {
            transfer_id, reply, ..
        } => {
            transfers.finish(transfer_id);
            emit_transfer_failed(&event_tx, session_id, transfer_id, err);
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpRead { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::SftpWrite { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        // Tunnel commands can also fail to queue when the worker is dead.
        SessionCmd::TunnelStart { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::TunnelStop { reply, .. } => {
            let _ = reply.send(Err(fail));
        }
        SessionCmd::TunnelList { reply } => {
            let _ = reply.send(Err(fail));
        }
        // Non-reply commands never reach a worker (Write/Resize/Shutdown/Exec 
        // run on the main thread; OpenShell too).
        _ => {}
    }
}

/// Emit a `failed` TransferProgress event for a transfer that could not start.
fn emit_transfer_failed(
    event_tx: &flume::Sender<SessionEvent>,
    session_id: Uuid,
    transfer_id: Uuid,
    err: &CoreError,
) {
    let _ = event_tx.send(SessionEvent::TransferProgress {
        transfer_id,
        session_id,
        bytes: 0,
        total: None,
        status: "failed".into(),
        error: Some(err.to_string()),
    });
}

/// Cheap liveness probe for the dedicated SFTP session: a `stat("/")` round trip
fn sftp_session_alive(conn: &Option<(Session, JumpHold)>, sftp: &Option<Sftp>) -> bool {
    match conn {
        None => false,
        Some((sess, _)) => match sftp {
            Some(s) => {
                let prev = sess.timeout();
                sess.set_timeout(4000);
                let ok = s.stat(std::path::Path::new("/")).is_ok();
                sess.set_timeout(prev);
                ok
            }
            None => sess.keepalive_send().is_ok(),
        },
    }
}

/// Tunnel sub-worker: owns a dedicated SSH session for all port forwards, polled
/// on its own thread so tunnel blocking-mode toggles never touch the terminal.
fn tunnel_worker_loop(
    session_id: Uuid,
    factory: SessionFactory,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
) {
    let (sess, hold) = match factory.establish_retry(3) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[tunnel-session] establish failed: {e}");
            while cmd_rx.try_recv().is_ok() {}
            return;
        }
    };
    sess.set_blocking(false);
    let mut local_tunnels: HashMap<Uuid, LocalTunnelHandle> = HashMap::new();
    let mut remote_tunnels: HashMap<Uuid, RemoteTunnelHandle> = HashMap::new();
    let poll = Duration::from_millis(15);
    // Throttled keepalive so an idle tunnel session isn't dropped by NAT/server.
    let mut last_keepalive = Instant::now();

    loop {
        if last_keepalive.elapsed() >= Duration::from_secs(15) {
            let _ = sess.keepalive_send();
            last_keepalive = Instant::now();
        }
        match cmd_rx.recv_timeout(poll) {
            Ok(SessionCmd::Shutdown) => break,
            Ok(SessionCmd::TunnelStart { config, reply }) => {
                let r = start_tunnel(
                    session_id, &factory, config, &mut local_tunnels, &mut remote_tunnels, &event_tx,
                );
                let _ = reply.send(r);
            }
            Ok(SessionCmd::TunnelStop { tunnel_id, reply }) => {
                let r = stop_tunnel(
                    session_id, tunnel_id, &mut local_tunnels, &mut remote_tunnels, &event_tx,
                );
                let _ = reply.send(r);
            }
            Ok(SessionCmd::TunnelList { reply }) => {
                let mut list = Vec::new();
                for h in local_tunnels.values() {
                    list.push(h.info.to_status(session_id));
                }
                for h in remote_tunnels.values() {
                    list.push(h.info.to_status(session_id));
                }
                list.sort_by(|a, b| a.name.cmp(&b.name));
                let _ = reply.send(Ok(list));
            }
            Ok(_) => {}
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => break,
        }
    }

    stop_all_tunnels(&mut local_tunnels, &mut remote_tunnels);
    drop(hold);
}

/// Poll in-flight exec channels: emit result on EOF, and enforce a wall-clock
/// timeout + output cap so a non-terminating / high-volume command cannot hang
/// the caller or grow memory without bound. stderr is drained into the output.
fn poll_pending_execs(pending: &mut Vec<PendingExec>, read_buf: &mut [u8]) {
    pending.retain_mut(|exec| {
        // stdout
        loop {
            match exec.channel.read(read_buf) {
                Ok(0) => {
                    // stdout EOF. Drain any remaining stderr before settling:
                    // a final stderr write (e.g. a trailing "command not found"
                    // diagnostic) can arrive after stdout closes, and the old
                    // code sent the result here immediately, losing that tail.
                    loop {
                        match exec.channel.stderr().read(read_buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                exec.output.extend_from_slice(&read_buf[..n]);
                                if exec.output.len() > EXEC_MAX_OUTPUT {
                                    let _ = exec.channel.close();
                                    let _ = exec.reply.send(Err(CoreError::Other(
                                        "exec output exceeded 16 MiB cap".into(),
                                    )));
                                    return false;
                                }
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                            Err(_) => break,
                        }
                    }
                    let out = std::mem::take(&mut exec.output);
                    let _ = exec.reply.send(Ok(String::from_utf8_lossy(&out).into_owned()));
                    return false;
                }
                Ok(n) => {
                    exec.output.extend_from_slice(&read_buf[..n]);
                    if exec.output.len() > EXEC_MAX_OUTPUT {
                        let _ = exec.channel.close();
                        let _ = exec.reply.send(Err(CoreError::Other(
                            "exec output exceeded 16 MiB cap".into(),
                        )));
                        return false;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(e) => {
                    eprintln!("[exec-poll] read error: {e}");
                    let _ = exec.reply.send(Err(CoreError::Other("exec read error".into())));
                    return false;
                }
            }
        }
        // stderr (best-effort, merged into the same output buffer)
        loop {
            match exec.channel.stderr().read(read_buf) {
                Ok(0) => break,
                Ok(n) => {
                    exec.output.extend_from_slice(&read_buf[..n]);
                    if exec.output.len() > EXEC_MAX_OUTPUT {
                        let _ = exec.channel.close();
                        let _ = exec.reply.send(Err(CoreError::Other(
                            "exec output exceeded 16 MiB cap".into(),
                        )));
                        return false;
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
        if exec.started.elapsed() > EXEC_TIMEOUT {
            let _ = exec.channel.close();
            let _ = exec.reply.send(Err(CoreError::Other("exec timed out after 60s".into())));
            return false;
        }
        true
    });
}

// ============================================================================
// Command dispatch helpers
// ============================================================================

/// Open an exec channel and start tracking it for async completion.
fn dispatch_exec(sess: &mut Session, cmd: SessionCmd, pending: &mut Vec<PendingExec>) {
    let SessionCmd::Exec { command, reply } = cmd else {
        return;
    };
    sess.set_blocking(true);
    match (|| -> Result<Channel, CoreError> {
        let mut ch = sess.channel_session()?;
        ch.exec(&command)?;
        Ok(ch)
    })() {
        Ok(ch) => {
            sess.set_blocking(false);
            pending.push(PendingExec {
                channel: ch,
                output: Vec::new(),
                reply,
                started: Instant::now(),
            });
        }
        Err(e) => {
            sess.set_blocking(false);
            eprintln!("[exec-dispatch] channel setup failed: {e}");
            let _ = reply.send(Err(e));
        }
    }
}

/// Write queued stdin bytes to the channel; keeps whatever still won't fit for
/// the next tick. Must run on the session worker thread (owns the Channel).
fn flush_pending_input(pair: &mut ShellChannelPair) {
    if pair.pending_input.is_empty() {
        return;
    }
    match terminal::try_write(&mut pair.channel, &pair.pending_input) {
        Ok(remaining) => {
            if remaining == 0 {
                pair.pending_input.clear();
            } else {
                // Keep only the tail that still couldn't be written.
                pair.pending_input.drain(..pair.pending_input.len() - remaining);
            }
        }
        Err(e) => {
            // Fatal channel error: drop the queue so we don't retry forever on a
            // dead channel; the connection teardown will surface the error.
            eprintln!("[ssh] input write failed, dropping {} queued bytes: {e}", pair.pending_input.len());
            pair.pending_input.clear();
        }
    }
}

/// Ensure SFTP is open; returns a mutable reference to the stored handle.
fn ensure_sftp<'a>(sess: &Session, sftp: &'a mut Option<Sftp>) -> Result<&'a mut Sftp, CoreError> {
    if sftp.is_none() {
        *sftp = Some(sftp_ops::open_sftp(sess)?);
    }
    sftp.as_mut().ok_or_else(|| CoreError::Other("SFTP handle not initialized".into()))
}

/// Handle one SFTP command on the dedicated (always-blocking) SFTP session.
/// Runs on the SFTP sub-worker thread, so even a large transfer only stalls
/// *this* session — never the interactive terminal.
fn handle_sftp_cmd(
    sess: &mut Session,
    session_id: Uuid,
    cmd: SessionCmd,
    sftp: &mut Option<Sftp>,
    event_tx: &flume::Sender<SessionEvent>,
    transfers: &TransferQueue,
) {
    match cmd {
        SessionCmd::OpenSftp { reply } => {
            if sftp.is_some() {
                let _ = reply.send(Ok(()));
                return;
            }
            match sftp_ops::open_sftp(sess) {
                Ok(handle) => {
                    *sftp = Some(handle);
                    let _ = reply.send(Ok(()));
                }
                Err(e) => {
                    let _ = reply.send(Err(e));
                }
            }
        }
        SessionCmd::SftpList { path, reply } => {
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                let list_path = if path.is_empty() || path == "." {
                    sftp_ops::realpath(s, ".")?
                } else {
                    path
                };
                sftp_ops::list(s, &list_path)
            })();
            let _ = reply.send(result);
        }
        SessionCmd::SftpMkdir { path, reply } => {
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::mkdir(s, &path));
            let _ = reply.send(result);
        }
        SessionCmd::SftpRm { path, reply } => {
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::remove(s, &path));
            let _ = reply.send(result);
        }
        SessionCmd::SftpRename { from, to, reply } => {
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::rename(s, &from, &to));
            let _ = reply.send(result);
        }
        SessionCmd::SftpChmod { path, mode, reply } => {
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::chmod(s, &path, mode));
            let _ = reply.send(result);
        }
        SessionCmd::SftpRealpath { path, reply } => {
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::realpath(s, &path));
            let _ = reply.send(result);
        }
        SessionCmd::SftpUpload {
            transfer_id,
            local_path,
            remote_path,
            cancel,
            reply,
        } => {
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                let event_tx = event_tx.clone();
                let cb = |bytes, total| {
                    let _ = event_tx.send(SessionEvent::TransferProgress {
                        transfer_id,
                        session_id,
                        bytes,
                        total,
                        status: "running".into(),
                        error: None,
                    });
                };
                // A directory source is uploaded recursively.
                if local_path.is_dir() {
                    sftp_ops::upload_dir(s, &local_path, &remote_path, &cancel, cb)
                } else {
                    sftp_ops::upload(s, &local_path, &remote_path, &cancel, cb)
                }
            })();
            emit_transfer_result(event_tx, session_id, transfer_id, result);
            transfers.finish(transfer_id);
            let _ = reply.send(Ok(()));
        }
        SessionCmd::SftpDownload {
            transfer_id,
            remote_path,
            local_path,
            cancel,
            reply,
        } => {
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                // A remote directory is downloaded recursively.
                let is_dir = s
                    .stat(std::path::Path::new(&remote_path))
                    .map(|st| st.is_dir())
                    .unwrap_or(false);
                let event_tx = event_tx.clone();
                let cb = |bytes, total| {
                    let _ = event_tx.send(SessionEvent::TransferProgress {
                        transfer_id,
                        session_id,
                        bytes,
                        total,
                        status: "running".into(),
                        error: None,
                    });
                };
                if is_dir {
                    sftp_ops::download_dir(s, &remote_path, &local_path, &cancel, cb)
                } else {
                    sftp_ops::download(s, &remote_path, &local_path, &cancel, cb)
                }
            })();
            emit_transfer_result(event_tx, session_id, transfer_id, result);
            transfers.finish(transfer_id);
            let _ = reply.send(Ok(()));
        }
        SessionCmd::SftpRead { remote_path, reply } => {
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                sftp_ops::read_text(s, &remote_path)
            })();
            let _ = reply.send(result);
        }
        SessionCmd::SftpWrite {
            remote_path,
            data,
            reply,
        } => {
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                sftp_ops::write_text(s, &remote_path, &data)
            })();
            let _ = reply.send(result);
        }
        // Non-SFTP commands never reach this worker.
        _ => {}
    }
}

// ============================================================================
// Tunnel management
// ============================================================================

fn emit_tunnel_status(event_tx: &flume::Sender<SessionEvent>, status: TunnelStatus) {
    let _ = event_tx.send(SessionEvent::TunnelStatus(status));
}

fn start_tunnel(
    session_id: Uuid,
    factory: &SessionFactory,
    config: TunnelConfig,
    local_tunnels: &mut HashMap<Uuid, LocalTunnelHandle>,
    remote_tunnels: &mut HashMap<Uuid, RemoteTunnelHandle>,
    event_tx: &flume::Sender<SessionEvent>,
) -> Result<(), CoreError> {
    let id = config.id;
    if local_tunnels.contains_key(&id) || remote_tunnels.contains_key(&id) {
        return Err(CoreError::Other(format!(
            "tunnel already running: {id}"
        )));
    }

    match &config.kind {
        TunnelType::Local {
            local_host,
            local_port,
            remote_host,
            remote_port,
        } => {
            let listener = tunnel::bind_listener(local_host, *local_port)?;
            let stop = Arc::new(AtomicBool::new(false));
            let factory_c = factory.clone();
            let stop_c = Arc::clone(&stop);
            let rh = remote_host.clone();
            let rp = *remote_port;
            let bind_host = local_host.clone();
            let bind_port = *local_port;
            let thread = thread::Builder::new()
                .name(format!("tunnel-local-{id}"))
                .spawn(move || {
                    tunnel::run_local_forward_loop(factory_c, listener, rh, rp, stop_c);
                })
                .map_err(|e| CoreError::Other(format!("spawn tunnel thread: {e}")))?;

            let info = TunnelRuntimeInfo {
                config: config.clone(),
                state: TunnelState::Running,
                error: None,
            };
            emit_tunnel_status(event_tx, info.to_status(session_id));
            local_tunnels.insert(
                id,
                LocalTunnelHandle {
                    info,
                    stop,
                    bind_host,
                    bind_port,
                    thread: Some(thread),
                },
            );
            Ok(())
        }
        TunnelType::Dynamic {
            local_host,
            local_port,
        } => {
            let listener = tunnel::bind_listener(local_host, *local_port)?;
            let stop = Arc::new(AtomicBool::new(false));
            let factory_c = factory.clone();
            let stop_c = Arc::clone(&stop);
            let bind_host = local_host.clone();
            let bind_port = *local_port;
            let thread = thread::Builder::new()
                .name(format!("tunnel-dynamic-{id}"))
                .spawn(move || {
                    tunnel::run_dynamic_forward_loop(factory_c, listener, stop_c);
                })
                .map_err(|e| CoreError::Other(format!("spawn tunnel thread: {e}")))?;

            let info = TunnelRuntimeInfo {
                config: config.clone(),
                state: TunnelState::Running,
                error: None,
            };
            emit_tunnel_status(event_tx, info.to_status(session_id));
            local_tunnels.insert(
                id,
                LocalTunnelHandle {
                    info,
                    stop,
                    bind_host,
                    bind_port,
                    thread: Some(thread),
                },
            );
            Ok(())
        }
        TunnelType::Remote {
            remote_host,
            remote_port,
            local_host,
            local_port,
        } => {
            // Remote forward runs on its own thread with its own authenticated
            // session (see tunnel::run_remote_forward_loop): the session worker
            // thread keeps polling *its* session, and libssh2 sessions must not
            // be shared across threads. `remote_host`/`remote_port` ride along
            // inside `config`; only the local target is needed here for status.
            let _ = (remote_host, remote_port);
            let stop = Arc::new(AtomicBool::new(false));
            let factory_c = factory.clone();
            let stop_c = Arc::clone(&stop);
            let config_c = config.clone();
            let thread = thread::Builder::new()
                .name(format!("tunnel-remote-{id}"))
                .spawn(move || {
                    tunnel::run_remote_forward_loop(factory_c, config_c, stop_c);
                })
                .map_err(|e| CoreError::Other(format!("spawn remote tunnel thread: {e}")))?;

            let info = TunnelRuntimeInfo {
                config: config.clone(),
                state: TunnelState::Running,
                error: None,
            };
            emit_tunnel_status(event_tx, info.to_status(session_id));
            remote_tunnels.insert(
                id,
                RemoteTunnelHandle {
                    info,
                    local_host: local_host.clone(),
                    local_port: *local_port,
                    stop,
                    thread: Some(thread),
                },
            );
            Ok(())
        }
    }
}

fn stop_tunnel(
    session_id: Uuid,
    tunnel_id: Uuid,
    local_tunnels: &mut HashMap<Uuid, LocalTunnelHandle>,
    remote_tunnels: &mut HashMap<Uuid, RemoteTunnelHandle>,
    event_tx: &flume::Sender<SessionEvent>,
) -> Result<(), CoreError> {
    if let Some(mut h) = local_tunnels.remove(&tunnel_id) {
        h.stop.store(true, Ordering::Relaxed);
        tunnel::wake_listener(&h.bind_host, h.bind_port);
        if let Some(t) = h.thread.take() {
            let _ = t.join();
        }
        h.info.state = TunnelState::Stopped;
        h.info.error = None;
        emit_tunnel_status(event_tx, h.info.to_status(session_id));
        return Ok(());
    }
    if let Some(mut h) = remote_tunnels.remove(&tunnel_id) {
        h.stop.store(true, Ordering::Relaxed);
        if let Some(t) = h.thread.take() {
            let _ = t.join();
        }
        h.info.state = TunnelState::Stopped;
        h.info.error = None;
        emit_tunnel_status(event_tx, h.info.to_status(session_id));
        return Ok(());
    }
    Err(CoreError::Other(format!(
        "tunnel not found: {tunnel_id}"
    )))
}

fn stop_all_tunnels(
    local_tunnels: &mut HashMap<Uuid, LocalTunnelHandle>,
    remote_tunnels: &mut HashMap<Uuid, RemoteTunnelHandle>,
) {
    let local_ids: Vec<Uuid> = local_tunnels.keys().copied().collect();
    for id in local_ids {
        if let Some(mut h) = local_tunnels.remove(&id) {
            h.stop.store(true, Ordering::Relaxed);
            tunnel::wake_listener(&h.bind_host, h.bind_port);
            if let Some(t) = h.thread.take() {
                let _ = t.join();
            }
        }
    }
    // Signal remote-forward relay threads (they hold a clone of this flag) then
    // join their dedicated threads, so in-flight inbound relays wind down.
    let remote_ids: Vec<Uuid> = remote_tunnels.keys().copied().collect();
    for id in remote_ids {
        if let Some(mut h) = remote_tunnels.remove(&id) {
            h.stop.store(true, Ordering::Relaxed);
            if let Some(t) = h.thread.take() {
                let _ = t.join();
            }
        }
    }
}

fn emit_transfer_result(
    event_tx: &flume::Sender<SessionEvent>,
    session_id: Uuid,
    transfer_id: Uuid,
    result: Result<sftp_ops::TransferOutcome, CoreError>,
) {
    match result {
        Ok(sftp_ops::TransferOutcome::Done { bytes, total }) => {
            let _ = event_tx.send(SessionEvent::TransferProgress {
                transfer_id,
                session_id,
                bytes,
                total,
                status: "done".into(),
                error: None,
            });
        }
        Ok(sftp_ops::TransferOutcome::Cancelled { bytes, total }) => {
            let _ = event_tx.send(SessionEvent::TransferProgress {
                transfer_id,
                session_id,
                bytes,
                total,
                status: "cancelled".into(),
                error: None,
            });
        }
        Err(e) => {
            let _ = event_tx.send(SessionEvent::TransferProgress {
                transfer_id,
                session_id,
                bytes: 0,
                total: None,
                status: "failed".into(),
                error: Some(e.to_string()),
            });
        }
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionManager;
    use protocol::{AuthMethod, ConnectionSource};

    fn dummy_conn() -> Connection {
        Connection {
            id: Uuid::nil(),
            name: "t".into(),
            host: "127.0.0.1".into(),
            port: 1,
            username: "u".into(),
            auth: AuthMethod::Password {
                credential_id: "mshell/nil/password".into(),
            },
            group: None,
            tags: vec![],
            jump_host: None,
            tunnels: vec![],
            protocol: Default::default(),
            source: ConnectionSource::Manual,
            last_connected: None,
            notes: None,
            serial_config: None,
            on_connect: None,
    color: None,
        }
    }

    #[test]
    fn manager_starts_empty() {
        let m = SessionManager::new();
        assert_eq!(m.session_count(), 0);
        assert!(!m.contains(Uuid::nil()));
    }

    #[test]
    fn open_shell_on_missing_session_errors() {
        let m = SessionManager::new();
        let err = m.open_shell(Uuid::new_v4(), 80, 24).unwrap_err();
        assert!(matches!(err, CoreError::SessionNotFound(_)));
    }

    #[test]
    fn disconnect_missing_errors() {
        let mut m = SessionManager::new();
        let err = m.disconnect(Uuid::new_v4()).unwrap_err();
        assert!(matches!(err, CoreError::SessionNotFound(_)));
    }

    #[test]
    #[ignore = "network-dependent: connects to 127.0.0.1:1 (CI firewalls may hang/behave oddly)"]
    fn connect_refused_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut m = SessionManager::new().with_known_hosts_path(dir.path().join("kh.json"));
        let err = m
            .connect(&dummy_conn(), KnownHostsPolicy::AcceptAll)
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("refused")
                || msg.contains("os error")
                || msg.contains("timed out")
                || msg.contains("io error")
                || msg.contains("failed")
                || msg.contains("connect")
                || matches!(err, CoreError::Io(_)),
            "unexpected error: {err:?} / {msg}"
        );
        assert_eq!(m.session_count(), 0);
    }

    // ── emit_transfer_result ──────────────────────────────────────────

    #[test]
    fn emit_done_sends_done_event() {
        let (tx, rx) = flume::unbounded();
        emit_transfer_result(&tx, Uuid::nil(), Uuid::nil(), Ok(sftp_ops::TransferOutcome::Done { bytes: 100, total: Some(200) }));
        let ev = rx.recv().unwrap();
        match ev {
            SessionEvent::TransferProgress { status, bytes, total, error, .. } => {
                assert_eq!(status, "done");
                assert_eq!(bytes, 100);
                assert_eq!(total, Some(200));
                assert!(error.is_none());
            }
            other => panic!("expected TransferProgress, got {other:?}"),
        }
    }

    #[test]
    fn emit_cancelled_sends_cancelled_event() {
        let (tx, rx) = flume::unbounded();
        emit_transfer_result(&tx, Uuid::nil(), Uuid::nil(), Ok(sftp_ops::TransferOutcome::Cancelled { bytes: 50, total: None }));
        let ev = rx.recv().unwrap();
        match ev {
            SessionEvent::TransferProgress { status, bytes, total, .. } => {
                assert_eq!(status, "cancelled");
                assert_eq!(bytes, 50);
                assert_eq!(total, None);
            }
            other => panic!("expected TransferProgress, got {other:?}"),
        }
    }

    #[test]
    fn emit_error_sends_failed_event() {
        let (tx, rx) = flume::unbounded();
        let err = CoreError::Auth("bad auth".into());
        emit_transfer_result(&tx, Uuid::nil(), Uuid::nil(), Err(err));
        let ev = rx.recv().unwrap();
        match ev {
            SessionEvent::TransferProgress { status, bytes, error, .. } => {
                assert_eq!(status, "failed");
                assert_eq!(bytes, 0);
                assert!(error.as_deref().unwrap().contains("bad auth"), "{error:?}");
            }
            other => panic!("expected TransferProgress, got {other:?}"),
        }
    }

    // ── tcp_connect_host ──────────────────────────────────────────────

    #[test]
    fn tcp_connect_empty_host_errors() {
        let err = tcp_connect_host("", 22, Duration::from_millis(10)).unwrap_err();
        assert!(!err.to_string().is_empty(), "expected error for empty host");
    }

    #[test]
    #[ignore = "network-dependent: performs a real DNS lookup (captive portals / wildcard DNS make it flaky)"]
    fn tcp_connect_invalid_host_errors() {
        let err = tcp_connect_host("hostname.does.not.exist.example", 22, Duration::from_millis(100)).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("DNS") || msg.contains("解析") || msg.contains("resolve") || msg.contains("failed") || msg.contains("timed out"),
            "expected DNS/connect error, got: {msg}"
        );
    }

    // ── JumpHold ──────────────────────────────────────────────────────

    #[test]
    fn jump_hold_default_is_empty() {
        let hold = JumpHold {
            hop_sessions: vec![],
            stop_flags: vec![],
            relays: vec![],
        };
        // Drop must not panic
        drop(hold);
    }

    #[test]
    fn jump_hold_drop_stops_flags() {
        use std::sync::atomic::AtomicBool;
        let flag = Arc::new(AtomicBool::new(false));
        let flag2 = Arc::clone(&flag);
        let hold = JumpHold {
            hop_sessions: vec![],
            stop_flags: vec![flag],
            relays: vec![],
        };
        drop(hold);
        assert!(flag2.load(Ordering::Relaxed), "JumpHold drop should set stop flag");
    }

    // ── stop_tunnel / stop_all_tunnels ──────────────────────────────

    #[test]
    fn stop_tunnel_missing_errors() {
        let mut local = HashMap::new();
        let mut remote = HashMap::new();
        let (tx, _rx) = flume::unbounded();
        let err = stop_tunnel(Uuid::nil(), Uuid::nil(), &mut local, &mut remote, &tx).unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
    }

    #[test]
    fn stop_all_tunnels_empty_no_panic() {
        let mut local = HashMap::new();
        let mut remote = HashMap::new();
        stop_all_tunnels(&mut local, &mut remote);
        assert!(local.is_empty());
        assert!(remote.is_empty());
    }

    #[test]
    fn stop_all_tunnels_clears_both_maps() {
        use crate::tunnel::LocalTunnelHandle;
        use std::sync::atomic::AtomicBool;

        let mut local: HashMap<Uuid, LocalTunnelHandle> = HashMap::new();
        let mut remote = HashMap::new();
        let tunnel_id = Uuid::new_v4();

        local.insert(tunnel_id, LocalTunnelHandle {
            info: TunnelRuntimeInfo {
                config: TunnelConfig {
                    id: tunnel_id,
                    name: "t".into(),
                    kind: TunnelType::Local {
                        local_host: "127.0.0.1".into(),
                        local_port: 8080,
                        remote_host: "10.0.0.1".into(),
                        remote_port: 80,
                    },
                    auto_start: false,
                },
                state: TunnelState::Running,
                error: None,
            },
            stop: Arc::new(AtomicBool::new(false)),
            bind_host: "127.0.0.1".into(),
            bind_port: 8080,
            thread: None,
        });

        stop_all_tunnels(&mut local, &mut remote);
        assert!(local.is_empty());
        assert!(remote.is_empty());
    }

    #[test]
    fn stop_tunnel_local_sets_stop_flag() {
        use crate::tunnel::LocalTunnelHandle;
        use std::sync::atomic::AtomicBool;

        let mut local: HashMap<Uuid, LocalTunnelHandle> = HashMap::new();
        let mut remote = HashMap::new();
        let (tx, _rx) = flume::unbounded();
        let tunnel_id = Uuid::new_v4();
        let flag = Arc::new(AtomicBool::new(false));
        let flag2 = Arc::clone(&flag);

        local.insert(tunnel_id, LocalTunnelHandle {
            info: TunnelRuntimeInfo {
                config: TunnelConfig {
                    id: tunnel_id,
                    name: "t".into(),
                    kind: TunnelType::Local {
                        local_host: "127.0.0.1".into(),
                        local_port: 8080,
                        remote_host: "10.0.0.1".into(),
                        remote_port: 80,
                    },
                    auto_start: false,
                },
                state: TunnelState::Running,
                error: None,
            },
            stop: flag,
            bind_host: "127.0.0.1".into(),
            bind_port: 8080,
            thread: None,
        });

        stop_tunnel(Uuid::nil(), tunnel_id, &mut local, &mut remote, &tx).unwrap();
        assert!(flag2.load(Ordering::Relaxed), "stop_tunnel should set stop flag");
        assert!(local.is_empty());
    }
}
