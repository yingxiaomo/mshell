//! In-process SSH session manager.
//!
//! # Threading model
//!
//! **One OS thread per [`LiveSession`]**, owning the `ssh2::Session`.
//! Commands are sent over a [`flume`] channel (`SessionCmd`). This avoids
//! `Send`/`Sync` issues with libssh2 session handles and keeps channel I/O
//! affinity on a single thread.
//!
//! Terminal output is pushed as [`SessionEvent`] on a shared flume sender so
//! the app crate can bridge to Tauri events without pulling Tauri into ssh-core.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use protocol::Connection;
use protocol::RemoteEntry;
use protocol::{TunnelConfig, TunnelStatus, TunnelType};
use ssh2::Session;
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

/// Events emitted by session workers (app crate bridges these to Tauri).
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// Raw PTY / shell stdout (or stderr) bytes for a channel.
    Output {
        session_id: Uuid,
        channel_id: Uuid,
        data: Vec<u8>,
    },
    /// Session worker exited or connection lost.
    Disconnected {
        session_id: Uuid,
        reason: String,
    },
    /// Upload/download progress (status: running | done | failed | cancelled).
    TransferProgress {
        transfer_id: Uuid,
        bytes: u64,
        total: Option<u64>,
        status: String,
        error: Option<String>,
    },
    /// Tunnel lifecycle / error updates.
    TunnelStatus(TunnelStatus),
}

/// Commands handled by the LiveSession worker thread.
pub enum SessionCmd {
    OpenShell {
        cols: u32,
        rows: u32,
        reply: flume::Sender<Result<Uuid, CoreError>>,
    },
    Write {
        channel_id: Uuid,
        data: Vec<u8>,
    },
    Resize {
        channel_id: Uuid,
        cols: u32,
        rows: u32,
    },
    OpenSftp {
        reply: flume::Sender<Result<(), CoreError>>,
    },
    SftpList {
        path: String,
        reply: flume::Sender<Result<Vec<RemoteEntry>, CoreError>>,
    },
    SftpMkdir {
        path: String,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    SftpRm {
        path: String,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    SftpRename {
        from: String,
        to: String,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    /// Resolve remote path via SFTP realpath (e.g. `"."` → home).
    SftpRealpath {
        path: String,
        reply: flume::Sender<Result<String, CoreError>>,
    },
    /// Local → remote file copy (runs on session worker; progress via events).
    SftpUpload {
        transfer_id: Uuid,
        local_path: PathBuf,
        remote_path: String,
        cancel: Arc<AtomicBool>,
        /// Fired once when the job is accepted / finished with final result.
        reply: flume::Sender<Result<(), CoreError>>,
    },
    /// Remote → local file copy.
    SftpDownload {
        transfer_id: Uuid,
        remote_path: String,
        local_path: PathBuf,
        cancel: Arc<AtomicBool>,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    TunnelStart {
        config: TunnelConfig,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    TunnelStop {
        tunnel_id: Uuid,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    TunnelList {
        reply: flume::Sender<Result<Vec<TunnelStatus>, CoreError>>,
    },
    Shutdown,
}

/// Handle to a running LiveSession worker.
struct LiveSessionHandle {
    connection_id: Uuid,
    cmd_tx: flume::Sender<SessionCmd>,
    /// Joined on disconnect/drop best-effort.
    thread: Option<JoinHandle<()>>,
}

/// In-process map of live SSH sessions keyed by runtime `session_id`.
pub struct SessionManager {
    sessions: HashMap<Uuid, LiveSessionHandle>,
    known_hosts_path: PathBuf,
    connect_timeout: Duration,
    /// Shared event fan-in for all workers. Dropped senders end when manager drops.
    event_tx: flume::Sender<SessionEvent>,
    /// Shared cancel registry for upload/download jobs.
    pub transfers: Arc<TransferQueue>,
}

impl SessionManager {
    /// Create a manager and the receiver for [`SessionEvent`]s.
    ///
    /// The app crate should spawn a bridge task on `event_rx` that emits Tauri
    /// events. Workers clone `event_tx` at connect time.
    pub fn create() -> (Self, flume::Receiver<SessionEvent>) {
        let (event_tx, event_rx) = flume::unbounded();
        (
            Self {
                sessions: HashMap::new(),
                known_hosts_path: host_key::default_known_hosts_path(),
                connect_timeout: Duration::from_secs(30),
                event_tx,
                transfers: Arc::new(TransferQueue::new()),
            },
            event_rx,
        )
    }

    /// Convenience for tests that ignore events.
    pub fn new() -> Self {
        Self::create().0
    }

    /// Override known_hosts.json path (tests / custom data dirs).
    pub fn with_known_hosts_path(mut self, path: PathBuf) -> Self {
        self.known_hosts_path = path;
        self
    }

    pub fn set_known_hosts_path(&mut self, path: PathBuf) {
        self.known_hosts_path = path;
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    pub fn contains(&self, session_id: Uuid) -> bool {
        self.sessions.contains_key(&session_id)
    }

    pub fn connection_id(&self, session_id: Uuid) -> Option<Uuid> {
        self.sessions.get(&session_id).map(|h| h.connection_id)
    }

    /// TCP + SSH handshake + host-key verify + authenticate.
    ///
    /// `jump_chain` is optional pre-resolved hop list **including** `conn` as the
    /// last element (`[bastion, …, target]`). When `None` or single-element, this
    /// is a direct connect. Use [`crate::jump::resolve_jump_chain`] + connection
    /// store to build the chain (detects cycles).
    ///
    /// Returns a new runtime `session_id`. Opening the same `connection_id`
    /// again yields another LiveSession. Call [`Self::open_shell`] next for PTY.
    pub fn connect(
        &mut self,
        conn: &Connection,
        policy: KnownHostsPolicy,
    ) -> Result<Uuid, CoreError> {
        self.connect_with_chain(conn, policy, None)
    }

    /// Like [`Self::connect`] but with an explicit ProxyJump hop chain.
    pub fn connect_with_chain(
        &mut self,
        conn: &Connection,
        policy: KnownHostsPolicy,
        jump_chain: Option<Vec<Connection>>,
    ) -> Result<Uuid, CoreError> {
        let session_id = Uuid::new_v4();
        let (cmd_tx, cmd_rx) = flume::unbounded::<SessionCmd>();
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), CoreError>>(1);

        let conn_clone = conn.clone();
        let chain = jump_chain.unwrap_or_else(|| vec![conn.clone()]);
        let known_hosts_path = self.known_hosts_path.clone();
        let timeout = self.connect_timeout;
        let connection_id = conn.id;
        let event_tx = self.event_tx.clone();
        let transfers = Arc::clone(&self.transfers);

        let thread = thread::Builder::new()
            .name(format!("ssh-session-{session_id}"))
            .spawn(move || {
                session_worker(
                    session_id,
                    conn_clone,
                    chain,
                    policy,
                    known_hosts_path,
                    timeout,
                    ready_tx,
                    cmd_rx,
                    event_tx,
                    transfers,
                );
            })
            .map_err(|e| CoreError::Other(format!("spawn session thread: {e}")))?;

        // Wait for connect+auth to finish (or fail) before registering.
        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.sessions.insert(
                    session_id,
                    LiveSessionHandle {
                        connection_id,
                        cmd_tx,
                        thread: Some(thread),
                    },
                );
                Ok(session_id)
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = thread.join();
                Err(CoreError::Other(
                    "session worker exited before ready signal".into(),
                ))
            }
        }
    }

    /// Send a command to a live session worker.
    pub fn send(&self, session_id: Uuid, cmd: SessionCmd) -> Result<(), CoreError> {
        let handle = self
            .sessions
            .get(&session_id)
            .ok_or(CoreError::SessionNotFound(session_id))?;
        handle
            .cmd_tx
            .send(cmd)
            .map_err(|_| CoreError::Other("session worker channel closed".into()))
    }

    /// Open a PTY shell on an authenticated session; returns `channel_id`.
    pub fn open_shell(
        &self,
        session_id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<Uuid, CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::OpenShell {
                cols,
                rows,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("open_shell reply channel closed".into()))?
    }

    /// Write bytes (already decoded) to a terminal channel.
    pub fn write(
        &self,
        session_id: Uuid,
        channel_id: Uuid,
        data: Vec<u8>,
    ) -> Result<(), CoreError> {
        self.send(session_id, SessionCmd::Write { channel_id, data })
    }

    /// Resize a terminal channel PTY.
    pub fn resize(
        &self,
        session_id: Uuid,
        channel_id: Uuid,
        cols: u32,
        rows: u32,
    ) -> Result<(), CoreError> {
        self.send(
            session_id,
            SessionCmd::Resize {
                channel_id,
                cols,
                rows,
            },
        )
    }

    /// Open the SFTP subsystem on an authenticated session (idempotent).
    pub fn open_sftp(&self, session_id: Uuid) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(session_id, SessionCmd::OpenSftp { reply: reply_tx })?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("open_sftp reply channel closed".into()))?
    }

    /// List remote directory entries (opens SFTP on demand if needed).
    pub fn sftp_list(&self, session_id: Uuid, path: String) -> Result<Vec<RemoteEntry>, CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::SftpList {
                path,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("sftp_list reply channel closed".into()))?
    }

    pub fn sftp_mkdir(&self, session_id: Uuid, path: String) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::SftpMkdir {
                path,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("sftp_mkdir reply channel closed".into()))?
    }

    pub fn sftp_rm(&self, session_id: Uuid, path: String) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::SftpRm {
                path,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("sftp_rm reply channel closed".into()))?
    }

    pub fn sftp_rename(
        &self,
        session_id: Uuid,
        from: String,
        to: String,
    ) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::SftpRename {
                from,
                to,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("sftp_rename reply channel closed".into()))?
    }

    pub fn sftp_realpath(&self, session_id: Uuid, path: String) -> Result<String, CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::SftpRealpath {
                path,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("sftp_realpath reply channel closed".into()))?
    }

    /// Enqueue an upload on the session worker. Returns `transfer_id` immediately;
    /// progress is reported via [`SessionEvent::TransferProgress`].
    ///
    /// The copy runs on the session worker and will block other cmds for that session
    /// until finished (V1 acceptable for moderate files).
    pub fn sftp_upload(
        &self,
        session_id: Uuid,
        local_path: PathBuf,
        remote_path: String,
    ) -> Result<Uuid, CoreError> {
        let transfer_id = Uuid::new_v4();
        let cancel = self.transfers.register(transfer_id);
        // Fire-and-forget reply; completion is event-driven.
        let (reply_tx, _reply_rx) = flume::bounded(1);
        if let Err(e) = self.send(
            session_id,
            SessionCmd::SftpUpload {
                transfer_id,
                local_path,
                remote_path,
                cancel,
                reply: reply_tx,
            },
        ) {
            self.transfers.finish(transfer_id);
            return Err(e);
        }
        Ok(transfer_id)
    }

    /// Enqueue a download. Same semantics as [`Self::sftp_upload`].
    pub fn sftp_download(
        &self,
        session_id: Uuid,
        remote_path: String,
        local_path: PathBuf,
    ) -> Result<Uuid, CoreError> {
        let transfer_id = Uuid::new_v4();
        let cancel = self.transfers.register(transfer_id);
        let (reply_tx, _reply_rx) = flume::bounded(1);
        if let Err(e) = self.send(
            session_id,
            SessionCmd::SftpDownload {
                transfer_id,
                remote_path,
                local_path,
                cancel,
                reply: reply_tx,
            },
        ) {
            self.transfers.finish(transfer_id);
            return Err(e);
        }
        Ok(transfer_id)
    }

    /// Request cancel for a running transfer.
    pub fn transfer_cancel(&self, transfer_id: Uuid) -> Result<(), CoreError> {
        if self.transfers.cancel(transfer_id) {
            Ok(())
        } else {
            Err(CoreError::Other(format!(
                "transfer not found: {transfer_id}"
            )))
        }
    }

    /// Start a port forward on a live session.
    pub fn tunnel_start(&self, session_id: Uuid, config: TunnelConfig) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::TunnelStart {
                config,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("tunnel_start reply channel closed".into()))?
    }

    /// Stop a running tunnel.
    pub fn tunnel_stop(&self, session_id: Uuid, tunnel_id: Uuid) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(
            session_id,
            SessionCmd::TunnelStop {
                tunnel_id,
                reply: reply_tx,
            },
        )?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("tunnel_stop reply channel closed".into()))?
    }

    /// List tunnel statuses for a session.
    pub fn tunnel_list(&self, session_id: Uuid) -> Result<Vec<TunnelStatus>, CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(session_id, SessionCmd::TunnelList { reply: reply_tx })?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("tunnel_list reply channel closed".into()))?
    }

    /// Gracefully stop a session worker and remove it from the map.
    pub fn disconnect(&mut self, session_id: Uuid) -> Result<(), CoreError> {
        let mut handle = self
            .sessions
            .remove(&session_id)
            .ok_or(CoreError::SessionNotFound(session_id))?;
        let _ = handle.cmd_tx.send(SessionCmd::Shutdown);
        if let Some(t) = handle.thread.take() {
            let _ = t.join();
        }
        Ok(())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        let ids: Vec<Uuid> = self.sessions.keys().copied().collect();
        for id in ids {
            let _ = self.disconnect(id);
        }
    }
}

/// Keeps intermediate jump sessions and localhost relay threads alive for the
/// lifetime of the target session. Relays are stopped on drop.
struct JumpHold {
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

#[allow(clippy::too_many_arguments)]
fn session_worker(
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
            let reason = run_cmd_loop(session_id, sess, cmd_rx, event_tx.clone(), transfers);
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

/// Establish SSH, possibly through ProxyJump hops.
///
/// `chain` is `[outermost_jump, …, target]` (len ≥ 1). Intermediate hops open a
/// local 127.0.0.1 relay into `channel_direct_tcpip` toward the next hop; the
/// final hop handshakes on that TCP stream (or direct TCP when len == 1).
///
/// # Why a localhost relay?
///
/// `ssh2::Session::set_tcp_stream` requires a real OS socket (`AsRawSocket` on
/// Windows / `AsRawFd` on Unix). An `ssh2::Channel` is only `Read`/`Write` and
/// cannot be passed to the next session. We therefore:
/// 1. TCP-connect the jump host and authenticate.
/// 2. Bind `127.0.0.1:0`, accept one client, and relay ↔ `channel_direct_tcpip`.
/// 3. Hand the accepted client socket to the next `Session::set_tcp_stream`.
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
    let addr = format!("{host}:{port}");
    let tcp = match addr.parse::<std::net::SocketAddr>() {
        Ok(sa) => TcpStream::connect_timeout(&sa, timeout)?,
        Err(_) => {
            let stream = TcpStream::connect(&addr)?;
            stream.set_read_timeout(Some(timeout))?;
            stream.set_write_timeout(Some(timeout))?;
            stream
        }
    };
    tcp.set_read_timeout(Some(timeout))?;
    tcp.set_write_timeout(Some(timeout))?;
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
            // One accept is enough for the target session lifetime.
            let _ = listener.set_nonblocking(false);
            let Ok((client, _)) = listener.accept() else {
                return;
            };
            if stop_c.load(Ordering::Relaxed) {
                return;
            }
            let _ = client.set_read_timeout(Some(timeout));
            let _ = client.set_write_timeout(Some(timeout));

            bastion.set_blocking(true);
            let channel = bastion.channel_direct_tcpip(&rh, rp, Some(("127.0.0.1", 0)));
            bastion.set_blocking(false);
            let Ok(channel) = channel else {
                return;
            };
            // Reuse tunnel relay (poll loop; works with mixed blocking modes).
            tunnel::relay_bidirectional(client, channel, &stop_c);
        })
        .map_err(|e| CoreError::Other(format!("spawn jump relay: {e}")))?;

    let stream = TcpStream::connect_timeout(&local_addr, timeout).map_err(CoreError::Io)?;
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
    sess.set_tcp_stream(tcp);
    sess.handshake()?;

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

fn run_cmd_loop(
    session_id: Uuid,
    mut sess: Session,
    cmd_rx: flume::Receiver<SessionCmd>,
    event_tx: flume::Sender<SessionEvent>,
    transfers: Arc<TransferQueue>,
) -> String {
    let mut channels: HashMap<Uuid, ssh2::Channel> = HashMap::new();
    let mut sftp: Option<ssh2::Sftp> = None;
    let mut local_tunnels: HashMap<Uuid, LocalTunnelHandle> = HashMap::new();
    let mut remote_tunnels: HashMap<Uuid, RemoteTunnelHandle> = HashMap::new();
    // Non-blocking so we can interleave cmds + multi-channel reads.
    sess.set_blocking(false);

    let mut read_buf = [0u8; 32 * 1024];
    let poll = Duration::from_millis(15);

    loop {
        // --- drain pending commands (non-blocking / short wait) ---
        match cmd_rx.recv_timeout(poll) {
            Ok(cmd) => {
                if handle_cmd(
                    &mut sess,
                    session_id,
                    cmd,
                    &mut channels,
                    &mut sftp,
                    &mut local_tunnels,
                    &mut remote_tunnels,
                    &event_tx,
                    &transfers,
                ) {
                    stop_all_tunnels(&mut local_tunnels, &mut remote_tunnels);
                    return "shutdown".into();
                }
            }
            Err(flume::RecvTimeoutError::Timeout) => {}
            Err(flume::RecvTimeoutError::Disconnected) => {
                stop_all_tunnels(&mut local_tunnels, &mut remote_tunnels);
                return "command channel closed".into();
            }
        }

        // Drain any additional queued commands without waiting.
        while let Ok(cmd) = cmd_rx.try_recv() {
            if handle_cmd(
                &mut sess,
                session_id,
                cmd,
                &mut channels,
                &mut sftp,
                &mut local_tunnels,
                &mut remote_tunnels,
                &event_tx,
                &transfers,
            ) {
                stop_all_tunnels(&mut local_tunnels, &mut remote_tunnels);
                return "shutdown".into();
            }
        }

        // --- poll channel I/O ---
        // Keepalive / process any transport packets.
        let _ = sess.keepalive_send();

        // Poll remote-forward listeners for inbound connections.
        poll_remote_tunnels(&mut sess, &mut remote_tunnels);

        let mut closed: Vec<Uuid> = Vec::new();
        for (channel_id, channel) in channels.iter_mut() {
            // stdout
            loop {
                match terminal::try_read(channel, &mut read_buf) {
                    Ok(Some(0)) => {
                        closed.push(*channel_id);
                        break;
                    }
                    Ok(Some(n)) => {
                        let _ = event_tx.send(SessionEvent::Output {
                            session_id,
                            channel_id: *channel_id,
                            data: read_buf[..n].to_vec(),
                        });
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
                match terminal::try_read_stderr(channel, &mut read_buf) {
                    Ok(Some(0)) | Ok(None) => break,
                    Ok(Some(n)) => {
                        let _ = event_tx.send(SessionEvent::Output {
                            session_id,
                            channel_id: *channel_id,
                            data: read_buf[..n].to_vec(),
                        });
                    }
                    Err(_) => break,
                }
            }

            if channel.eof() {
                closed.push(*channel_id);
            }
        }

        for id in closed {
            if let Some(mut ch) = channels.remove(&id) {
                let _ = ch.close();
                let _ = ch.wait_close();
            }
        }
    }
}

/// Ensure SFTP is open; returns a mutable reference to the stored handle.
/// Caller must put the session in blocking mode for the open handshake.
fn ensure_sftp<'a>(
    sess: &Session,
    sftp: &'a mut Option<ssh2::Sftp>,
) -> Result<&'a mut ssh2::Sftp, CoreError> {
    if sftp.is_none() {
        *sftp = Some(sftp_ops::open_sftp(sess)?);
    }
    Ok(sftp.as_mut().expect("just inserted"))
}

/// Returns `true` if the worker should exit (Shutdown).
#[allow(clippy::too_many_arguments)]
fn handle_cmd(
    sess: &mut Session,
    session_id: Uuid,
    cmd: SessionCmd,
    channels: &mut HashMap<Uuid, ssh2::Channel>,
    sftp: &mut Option<ssh2::Sftp>,
    local_tunnels: &mut HashMap<Uuid, LocalTunnelHandle>,
    remote_tunnels: &mut HashMap<Uuid, RemoteTunnelHandle>,
    event_tx: &flume::Sender<SessionEvent>,
    transfers: &TransferQueue,
) -> bool {
    match cmd {
        SessionCmd::Shutdown => true,
        SessionCmd::OpenShell { cols, rows, reply } => {
            // channel_session / request_pty / shell need blocking mode.
            sess.set_blocking(true);
            let result = terminal::open_shell(sess, cols, rows);
            sess.set_blocking(false);
            match result {
                Ok((channel_id, channel)) => {
                    channels.insert(channel_id, channel);
                    let _ = reply.send(Ok(channel_id));
                }
                Err(e) => {
                    let _ = reply.send(Err(e));
                }
            }
            false
        }
        SessionCmd::Write { channel_id, data } => {
            if let Some(ch) = channels.get_mut(&channel_id) {
                // Temporarily block for a reliable write of small keystroke batches.
                sess.set_blocking(true);
                if let Err(e) = terminal::write_all(ch, &data) {
                    // Ignore broken-pipe style errors; channel may be closing.
                    if !matches!(
                        e,
                        CoreError::Io(ref io) if io.kind() == ErrorKind::BrokenPipe
                            || io.kind() == ErrorKind::ConnectionReset
                    ) {
                        let _ = e;
                    }
                }
                sess.set_blocking(false);
            }
            false
        }
        SessionCmd::Resize {
            channel_id,
            cols,
            rows,
        } => {
            if let Some(ch) = channels.get_mut(&channel_id) {
                sess.set_blocking(true);
                let _ = terminal::resize(ch, cols, rows);
                sess.set_blocking(false);
            }
            false
        }
        SessionCmd::OpenSftp { reply } => {
            if sftp.is_some() {
                let _ = reply.send(Ok(()));
                return false;
            }
            sess.set_blocking(true);
            let result = sftp_ops::open_sftp(sess);
            sess.set_blocking(false);
            match result {
                Ok(handle) => {
                    *sftp = Some(handle);
                    let _ = reply.send(Ok(()));
                }
                Err(e) => {
                    let _ = reply.send(Err(e));
                }
            }
            false
        }
        SessionCmd::SftpList { path, reply } => {
            sess.set_blocking(true);
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                // Empty / "." → resolve home (or cwd) then list.
                let list_path = if path.is_empty() || path == "." {
                    sftp_ops::realpath(s, ".")?
                } else {
                    path
                };
                sftp_ops::list(s, &list_path)
            })();
            sess.set_blocking(false);
            let _ = reply.send(result);
            false
        }
        SessionCmd::SftpMkdir { path, reply } => {
            sess.set_blocking(true);
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::mkdir(s, &path));
            sess.set_blocking(false);
            let _ = reply.send(result);
            false
        }
        SessionCmd::SftpRm { path, reply } => {
            sess.set_blocking(true);
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::remove(s, &path));
            sess.set_blocking(false);
            let _ = reply.send(result);
            false
        }
        SessionCmd::SftpRename { from, to, reply } => {
            sess.set_blocking(true);
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::rename(s, &from, &to));
            sess.set_blocking(false);
            let _ = reply.send(result);
            false
        }
        SessionCmd::SftpRealpath { path, reply } => {
            sess.set_blocking(true);
            let result = ensure_sftp(sess, sftp).and_then(|s| sftp_ops::realpath(s, &path));
            sess.set_blocking(false);
            let _ = reply.send(result);
            false
        }
        SessionCmd::SftpUpload {
            transfer_id,
            local_path,
            remote_path,
            cancel,
            reply,
        } => {
            sess.set_blocking(true);
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                let event_tx = event_tx.clone();
                sftp_ops::upload(s, &local_path, &remote_path, &cancel, |bytes, total| {
                    let _ = event_tx.send(SessionEvent::TransferProgress {
                        transfer_id,
                        bytes,
                        total,
                        status: "running".into(),
                        error: None,
                    });
                })
            })();
            sess.set_blocking(false);
            emit_transfer_result(event_tx, transfer_id, result);
            transfers.finish(transfer_id);
            let _ = reply.send(Ok(()));
            false
        }
        SessionCmd::SftpDownload {
            transfer_id,
            remote_path,
            local_path,
            cancel,
            reply,
        } => {
            sess.set_blocking(true);
            let result = (|| {
                let s = ensure_sftp(sess, sftp)?;
                let event_tx = event_tx.clone();
                sftp_ops::download(s, &remote_path, &local_path, &cancel, |bytes, total| {
                    let _ = event_tx.send(SessionEvent::TransferProgress {
                        transfer_id,
                        bytes,
                        total,
                        status: "running".into(),
                        error: None,
                    });
                })
            })();
            sess.set_blocking(false);
            emit_transfer_result(event_tx, transfer_id, result);
            transfers.finish(transfer_id);
            let _ = reply.send(Ok(()));
            false
        }
        SessionCmd::TunnelStart { config, reply } => {
            let result = start_tunnel(
                sess,
                session_id,
                config,
                local_tunnels,
                remote_tunnels,
                event_tx,
            );
            let _ = reply.send(result);
            false
        }
        SessionCmd::TunnelStop { tunnel_id, reply } => {
            let result = stop_tunnel(
                session_id,
                tunnel_id,
                local_tunnels,
                remote_tunnels,
                event_tx,
            );
            let _ = reply.send(result);
            false
        }
        SessionCmd::TunnelList { reply } => {
            let mut list = Vec::new();
            for h in local_tunnels.values() {
                list.push(h.info.to_status(session_id));
            }
            for h in remote_tunnels.values() {
                list.push(h.info.to_status(session_id));
            }
            list.sort_by(|a, b| a.name.cmp(&b.name));
            let _ = reply.send(Ok(list));
            false
        }
    }
}

fn emit_tunnel_status(event_tx: &flume::Sender<SessionEvent>, status: TunnelStatus) {
    let _ = event_tx.send(SessionEvent::TunnelStatus(status));
}

fn start_tunnel(
    sess: &mut Session,
    session_id: Uuid,
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
            let sess_c = sess.clone();
            let stop_c = Arc::clone(&stop);
            let rh = remote_host.clone();
            let rp = *remote_port;
            let bind_host = local_host.clone();
            let bind_port = *local_port;
            let thread = thread::Builder::new()
                .name(format!("tunnel-local-{id}"))
                .spawn(move || {
                    tunnel::run_local_forward_loop(sess_c, listener, rh, rp, stop_c);
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
            let sess_c = sess.clone();
            let stop_c = Arc::clone(&stop);
            let bind_host = local_host.clone();
            let bind_port = *local_port;
            let thread = thread::Builder::new()
                .name(format!("tunnel-dynamic-{id}"))
                .spawn(move || {
                    tunnel::run_dynamic_forward_loop(sess_c, listener, stop_c);
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
            // Best-effort remote forward via libssh2 channel_forward_listen.
            sess.set_blocking(true);
            let result = sess.channel_forward_listen(
                *remote_port,
                Some(remote_host.as_str()),
                Some(16),
            );
            sess.set_blocking(false);
            match result {
                Ok((listener, _bound)) => {
                    let stop = Arc::new(AtomicBool::new(false));
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
                            listener,
                            local_host: local_host.clone(),
                            local_port: *local_port,
                            stop,
                        },
                    );
                    Ok(())
                }
                Err(e) => {
                    let msg = format!("remote forward failed: {e}");
                    let info = TunnelRuntimeInfo {
                        config,
                        state: TunnelState::Error,
                        error: Some(msg.clone()),
                    };
                    emit_tunnel_status(event_tx, info.to_status(session_id));
                    Err(CoreError::Ssh(msg))
                }
            }
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
        // Drop listener to cancel remote listen (libssh2 cancel on Drop).
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
    remote_tunnels.clear();
}

/// Non-blocking accept on remote-forward listeners; spawn relay per inbound.
fn poll_remote_tunnels(
    sess: &mut Session,
    remote_tunnels: &mut HashMap<Uuid, RemoteTunnelHandle>,
) {
    // Accept needs a brief blocking window; keep timeout short via session timeout.
    let prev_timeout = sess.timeout();
    sess.set_timeout(1);
    sess.set_blocking(true);
    for h in remote_tunnels.values_mut() {
        if h.stop.load(Ordering::Relaxed) {
            continue;
        }
        match h.listener.accept() {
            Ok(channel) => {
                let local_host = h.local_host.clone();
                let local_port = h.local_port;
                let stop = Arc::clone(&h.stop);
                // Relay off the session worker so we don't block PTY/SFTP.
                // Channel holds a Session clone; safe across threads (ssh2 Session is Arc).
                let _ = thread::Builder::new()
                    .name("tunnel-relay-remote".into())
                    .spawn(move || {
                        tunnel::handle_remote_inbound(channel, &local_host, local_port, &stop);
                    });
            }
            Err(_) => {
                // timeout / would-block / no pending
            }
        }
    }
    sess.set_blocking(false);
    sess.set_timeout(prev_timeout);
}

fn emit_transfer_result(
    event_tx: &flume::Sender<SessionEvent>,
    transfer_id: Uuid,
    result: Result<sftp_ops::TransferOutcome, CoreError>,
) {
    match result {
        Ok(sftp_ops::TransferOutcome::Done { bytes, total }) => {
            let _ = event_tx.send(SessionEvent::TransferProgress {
                transfer_id,
                bytes,
                total,
                status: "done".into(),
                error: None,
            });
        }
        Ok(sftp_ops::TransferOutcome::Cancelled { bytes, total }) => {
            let _ = event_tx.send(SessionEvent::TransferProgress {
                transfer_id,
                bytes,
                total,
                status: "cancelled".into(),
                error: None,
            });
        }
        Err(e) => {
            let _ = event_tx.send(SessionEvent::TransferProgress {
                transfer_id,
                bytes: 0,
                total: None,
                status: "failed".into(),
                error: Some(e.to_string()),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{AuthMethod, ConnectionSource};

    fn dummy_conn() -> Connection {
        Connection {
            id: Uuid::nil(),
            name: "t".into(),
            host: "127.0.0.1".into(),
            port: 1, // nothing listening — connect fails without network auth
            username: "u".into(),
            auth: AuthMethod::Password {
                credential_id: "momoshell/nil/password".into(),
            },
            group: None,
            tags: vec![],
            jump_host: None,
            tunnels: vec![],
            source: ConnectionSource::Manual,
            last_connected: None,
            notes: None,
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

    /// Connect to a closed port should fail quickly (no network auth success).
    #[test]
    fn connect_refused_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut m = SessionManager::new().with_known_hosts_path(dir.path().join("kh.json"));
        // Short path: port 1 typically refused on localhost.
        let err = m
            .connect(&dummy_conn(), KnownHostsPolicy::AcceptAll)
            .unwrap_err();
        // Io or Other/Ssh — must not panic or hang indefinitely.
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
}
