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
//!
//! # Architecture
//!
//! - [`SessionManager`] — public API: connect, open shell, SFTP, tunnels, etc.
//! - [`SessionCmd`] — commands sent to worker threads over channels.
//! - [`SessionEvent`] — events emitted by worker threads (Output, Disconnected, …).
//! - [`LiveSessionHandle`] — internal handle for each worker thread.
//!
//! The actual worker loops and SSH protocol logic live in [`session_worker`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use protocol::{
    Connection, ConnectionProtocol, RemoteEntry, TunnelConfig, TunnelStatus,
};
use uuid::Uuid;

use crate::error::CoreError;
use crate::host_key::{self, KnownHostsPolicy};
use crate::transfer::TransferQueue;
use crate::session_worker;

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
        session_id: Uuid,
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
    /// Change remote file permissions (chmod).
    SftpChmod {
        path: String,
        mode: u32,
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
        cancel: Arc<std::sync::atomic::AtomicBool>,
        /// Fired once when the job is accepted / finished with final result.
        reply: flume::Sender<Result<(), CoreError>>,
    },
    /// Remote → local file copy.
    SftpDownload {
        transfer_id: Uuid,
        remote_path: String,
        local_path: PathBuf,
        cancel: Arc<std::sync::atomic::AtomicBool>,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    /// Read a remote file into a base64 string (for built-in editor).
    SftpRead {
        remote_path: String,
        reply: flume::Sender<Result<Vec<u8>, CoreError>>,
    },
    /// Write binary data to a remote file (for built-in editor).
    SftpWrite {
        remote_path: String,
        data: Vec<u8>,
        reply: flume::Sender<Result<(), CoreError>>,
    },
    /// Execute a command in a subshell and return stdout (no PTY).
    Exec {
        command: String,
        reply: flume::Sender<Result<String, CoreError>>,
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
type SpawnSshResult = (Uuid, flume::Receiver<Result<(), CoreError>>, thread::JoinHandle<()>);
type SpawnSessionResult = (Uuid, flume::Receiver<SessionCmd>, flume::Receiver<Result<(), CoreError>>, thread::JoinHandle<()>);

pub(crate) struct LiveSessionHandle {
    connection_id: Uuid,
    cmd_tx: flume::Sender<SessionCmd>,
    /// Joined on disconnect/drop best-effort.
    thread: Option<thread::JoinHandle<()>>,
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
        match conn.protocol {
            ConnectionProtocol::Telnet => self.connect_telnet(conn),
            ConnectionProtocol::Local => self.connect_local(conn),
            ConnectionProtocol::Serial => self.connect_serial(conn),
            ConnectionProtocol::Ssh => self.connect_ssh(conn, policy, jump_chain),
        }
    }

    /// Same as connect_with_chain for SSH but returns before the SSH
    /// handshake completes.  The caller receives (session_id, ready_rx)
    /// and waits on ready_rx after releasing any outer lock.
    pub fn spawn_ssh(
        &mut self,
        conn: &Connection,
        policy: KnownHostsPolicy,
        jump_chain: Option<Vec<Connection>>,
    ) -> Result<SpawnSshResult, CoreError> {
        let (session_id, _cmd_rx, ready_rx, thread) = self.spawn_session(conn, policy, jump_chain)?;
        Ok((session_id, ready_rx, thread))
    }

    fn connect_telnet(&mut self, conn: &Connection) -> Result<Uuid, CoreError> {
        let session_id = Uuid::new_v4();
        let (cmd_tx, cmd_rx) = flume::unbounded::<SessionCmd>();
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), CoreError>>(1);

        let host = conn.host.clone();
        let port = conn.port;
        let timeout = self.connect_timeout;
        let connection_id = conn.id;
        let event_tx = self.event_tx.clone();
        let transfers = Arc::clone(&self.transfers);

        let thread = thread::Builder::new()
            .name(format!("telnet-session-{session_id}"))
            .spawn(move || {
                session_worker::telnet_session_worker(session_id, host, port, timeout, ready_tx, cmd_rx, event_tx, transfers);
            })
            .map_err(|e| CoreError::Other(format!("spawn telnet thread: {e}")))?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.sessions.insert(
                    session_id,
                    LiveSessionHandle { connection_id, cmd_tx, thread: Some(thread) },
                );
                Ok(session_id)
            }
            Ok(Err(e)) => { let _ = thread.join(); Err(e) }
            Err(_) => { let _ = thread.join(); Err(CoreError::Other("telnet worker exited before ready".into())) }
        }
    }

    fn connect_local(&mut self, conn: &protocol::Connection) -> Result<Uuid, CoreError> {
        let session_id = Uuid::new_v4();
        let (cmd_tx, cmd_rx) = flume::unbounded::<SessionCmd>();
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), CoreError>>(1);

        let timeout = self.connect_timeout;
        let connection_id = conn.id;
        let event_tx = self.event_tx.clone();
        let transfers = Arc::clone(&self.transfers);

        let thread = thread::Builder::new()
            .name(format!("local-session-{session_id}"))
            .spawn(move || {
                session_worker::local_session_worker(session_id, timeout, ready_tx, cmd_rx, event_tx, transfers);
            })
            .map_err(|e| CoreError::Other(format!("spawn local thread: {e}")))?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.sessions.insert(
                    session_id,
                    LiveSessionHandle { connection_id, cmd_tx, thread: Some(thread) },
                );
                Ok(session_id)
            }
            Ok(Err(e)) => { let _ = thread.join(); Err(e) }
            Err(_) => { let _ = thread.join(); Err(CoreError::Other("local worker exited before ready".into())) }
        }
    }

    fn connect_serial(&mut self, conn: &protocol::Connection) -> Result<Uuid, CoreError> {
        let session_id = Uuid::new_v4();
        let (cmd_tx, cmd_rx) = flume::unbounded::<SessionCmd>();
        let (ready_tx, ready_rx) = flume::bounded::<Result<(), CoreError>>(1);

        let config = conn.serial_config.clone().ok_or_else(|| {
            CoreError::Other("串口连接缺少 serialConfig（端口号 / 波特率）".into())
        })?;
        if config.port_name.trim().is_empty() {
            return Err(CoreError::Other("串口名称不能为空".into()));
        }
        let timeout = self.connect_timeout;
        let connection_id = conn.id;
        let event_tx = self.event_tx.clone();
        let transfers = Arc::clone(&self.transfers);

        let thread = thread::Builder::new()
            .name(format!("serial-session-{session_id}"))
            .spawn(move || {
                session_worker::serial_session_worker(session_id, config, timeout, ready_tx, cmd_rx, event_tx, transfers);
            })
            .map_err(|e| CoreError::Other(format!("spawn serial thread: {e}")))?;

        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.sessions.insert(
                    session_id,
                    LiveSessionHandle { connection_id, cmd_tx, thread: Some(thread) },
                );
                Ok(session_id)
            }
            Ok(Err(e)) => { let _ = thread.join(); Err(e) }
            Err(_) => { let _ = thread.join(); Err(CoreError::Other("serial worker exited before ready".into())) }
        }
    }

    fn connect_ssh(
        &mut self,
        conn: &Connection,
        policy: KnownHostsPolicy,
        jump_chain: Option<Vec<Connection>>,
    ) -> Result<Uuid, CoreError> {
        let (session_id, _, ready_rx, thread) = self.spawn_session(conn, policy, jump_chain)?;
        // `recv()` yields Result<Result<(), CoreError>, RecvError>: the OUTER
        // error is a dead worker, the INNER error is a real connect/auth/host-key
        // failure. Both must remove the placeholder handle spawn_session inserted,
        // otherwise a zombie session lingers in the map.
        match ready_rx.recv() {
            Ok(Ok(())) => {
                self.attach_thread(session_id, thread)?;
                Ok(session_id)
            }
            Ok(Err(e)) => {
                self.sessions.remove(&session_id);
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                self.sessions.remove(&session_id);
                let _ = thread.join();
                Err(CoreError::Other("ready channel closed".into()))
            }
        }
    }

    /// Like [`connect_ssh`] but spawns the worker thread, inserts a placeholder
    /// handle into the session map, and returns immediately.  The caller must
    /// wait on `ready_rx` separately (without holding any lock) and then call
    /// [`set_ready`] to finalize the handle.
    fn spawn_session(
        &mut self,
        conn: &Connection,
        policy: KnownHostsPolicy,
        jump_chain: Option<Vec<Connection>>,
    ) -> Result<SpawnSessionResult, CoreError> {
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

        let cmd_rx2 = cmd_rx.clone();
        let thread = thread::Builder::new()
            .name(format!("ssh-session-{session_id}"))
            .spawn(move || {
                session_worker::session_worker(
                    session_id,
                    conn_clone,
                    chain,
                    policy,
                    known_hosts_path,
                    timeout,
                    ready_tx,
                    cmd_rx2,
                    event_tx,
                    transfers,
                );
            })
            .map_err(|e| CoreError::Other(format!("spawn session thread: {e}")))?;

        // Insert a placeholder handle (cmd_tx is cloned for the return).
        let cmd_tx2 = cmd_tx.clone();
        self.sessions.insert(
            session_id,
            LiveSessionHandle {
                connection_id,
                cmd_tx: cmd_tx2,
                thread: None,
            },
        );
        Ok((session_id, cmd_rx, ready_rx, thread))
    }

    /// Replace the thread handle on a pending session (set after ready signal).
    pub fn attach_thread(
        &mut self,
        session_id: Uuid,
        thread: thread::JoinHandle<()>,
    ) -> Result<(), CoreError> {
        if let Some(handle) = self.sessions.get_mut(&session_id) {
            handle.thread = Some(thread);
            Ok(())
        } else {
            Err(CoreError::SessionNotFound(session_id))
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

    /// Return a copy of the command sender for a session (no lock retained).
    pub fn sender(&self, session_id: Uuid) -> Result<flume::Sender<SessionCmd>, CoreError> {
        self.sessions
            .get(&session_id)
            .map(|handle| handle.cmd_tx.clone())
            .ok_or(CoreError::SessionNotFound(session_id))
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

    /// Execute a command and return its stdout.
    pub fn exec(&self, session_id: Uuid, command: String) -> Result<String, CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(session_id, SessionCmd::Exec { command, reply: reply_tx })?;
        reply_rx.recv().map_err(|_| CoreError::Other("reply channel closed".into()))?
    }

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

    /// Change remote file permissions.
    pub fn sftp_chmod(&self, session_id: Uuid, path: String, mode: u32) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(session_id, SessionCmd::SftpChmod { path, mode, reply: reply_tx })?;
        reply_rx.recv().map_err(|_| CoreError::Other("reply channel closed".into()))?
    }

    /// Enqueue an upload on the session worker. Returns `transfer_id` immediately;
    /// progress is reported via [`SessionEvent::TransferProgress`].
    pub fn sftp_upload(
        &self,
        session_id: Uuid,
        local_path: PathBuf,
        remote_path: String,
    ) -> Result<Uuid, CoreError> {
        let transfer_id = Uuid::new_v4();
        let cancel = self.transfers.register(transfer_id);
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

    /// Read a remote file into memory (bytes). For built-in file editor.
    pub fn sftp_read(&self, session_id: Uuid, remote_path: String) -> Result<Vec<u8>, CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(session_id, SessionCmd::SftpRead { remote_path, reply: reply_tx })?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("sftp_read reply channel closed".into()))?
    }

    /// Write bytes to a remote file. For built-in file editor.
    pub fn sftp_write(&self, session_id: Uuid, remote_path: String, data: Vec<u8>) -> Result<(), CoreError> {
        let (reply_tx, reply_rx) = flume::bounded(1);
        self.send(session_id, SessionCmd::SftpWrite { remote_path, data, reply: reply_tx })?;
        reply_rx
            .recv()
            .map_err(|_| CoreError::Other("sftp_write reply channel closed".into()))?
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
