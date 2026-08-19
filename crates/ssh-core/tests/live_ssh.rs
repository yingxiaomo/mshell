//! End-to-end integration tests against a real (paramiko) SSH server.
//!
//! These are `#[ignore]` because they need Python + paramiko, `ssh-keygen`, and
//! network sockets. The server harness lives at `tests/support/ssh_server.py`
//! and a throwaway keypair is generated at runtime, so no setup is required:
//!
//! ```text
//! cargo test -p ssh-core --test live_ssh -- --ignored --nocapture
//! ```
//!
//! Overridable via env: `MOMO_PY` (python exe), `MOMO_SERVER_PY`, `MOMO_KEY` +
//! `MOMO_PUB` (private/public key paths). If Python/paramiko/ssh-keygen are
//! absent the tests self-skip.
//!
//! They exercise the isolated-session refactor: interactive shell, exec, SFTP
//! (on its own connection), local port-forward (on its own connection), the
//! Strict host-key path, and clean shell-close / disconnect teardown.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use protocol::{
    AuthMethod, Connection, ConnectionProtocol, ConnectionSource, TunnelConfig, TunnelType,
};
use ssh_core::{KnownHostsPolicy, SessionEvent, SessionManager};
use uuid::Uuid;

struct Server {
    child: Child,
    ssh_port: u16,
    echo_port: u16,
    root: PathBuf,
    count_file: PathBuf,
    key: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

fn free_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

/// Path to the bundled paramiko server harness (env override wins).
fn server_script() -> PathBuf {
    env("MOMO_SERVER_PY").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("support")
            .join("ssh_server.py")
    })
}

/// Return (private, public) key paths — from env if set, else generate a
/// throwaway RSA keypair with `ssh-keygen` into a temp dir. `None` if
/// `ssh-keygen` is unavailable.
fn key_pair() -> Option<(String, String)> {
    if let (Some(k), Some(p)) = (env("MOMO_KEY"), env("MOMO_PUB")) {
        return Some((k, p));
    }
    let dir = std::env::temp_dir().join(format!("momo-key-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&dir).ok()?;
    let priv_path = dir.join("id_rsa");
    let status = Command::new("ssh-keygen")
        .args(["-t", "rsa", "-b", "3072", "-N", "", "-q", "-f"])
        .arg(&priv_path)
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    let pub_path = dir.join("id_rsa.pub");
    Some((priv_path.to_string_lossy().into(), pub_path.to_string_lossy().into()))
}

fn start_server() -> Option<Server> {
    let server_py = server_script();
    if !server_py.exists() {
        eprintln!("SKIP: server harness not found at {}", server_py.display());
        return None;
    }
    let (key, pub_key) = key_pair()?;
    let py = env("MOMO_PY").unwrap_or_else(|| "python".into());

    let tmp = std::env::temp_dir().join(format!("momo-sshtest-{}", Uuid::new_v4()));
    let root = tmp.join("root");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("greeting.txt"), b"hello-from-server\n").unwrap();
    let count_file = tmp.join("conns.txt");

    let mut child = Command::new(py)
        .arg(&server_py)
        .arg("--authkey")
        .arg(&pub_key)
        .arg("--root")
        .arg(&root)
        .arg("--count-file")
        .arg(&count_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn python server");

    // First stdout line is the JSON with the ports.
    let stdout = child.stdout.take().unwrap();
    let mut line = String::new();
    BufReader::new(stdout).read_line(&mut line).unwrap();
    let v: serde_json::Value = serde_json::from_str(line.trim()).expect("server port json");
    let ssh_port = v["ssh_port"].as_u64().unwrap() as u16;
    let echo_port = v["echo_port"].as_u64().unwrap() as u16;

    Some(Server { child, ssh_port, echo_port, root, count_file, key })
}

fn conn_for(port: u16, key: &str) -> Connection {
    Connection {
        id: Uuid::new_v4(),
        name: "test".into(),
        host: "127.0.0.1".into(),
        port,
        protocol: ConnectionProtocol::Ssh,
        username: "momo".into(),
        auth: AuthMethod::PrivateKey { path: key.to_string(), passphrase_credential_id: None },
        group: None,
        tags: vec![],
        jump_host: None,
        tunnels: vec![],
        source: ConnectionSource::Manual,
        last_connected: None,
        notes: None,
        serial_config: None,
        on_connect: None,
    }
}

/// Collect terminal Output bytes for up to `dur`, stopping early once `needle`
/// appears.
fn wait_output(rx: &flume::Receiver<SessionEvent>, needle: &str, dur: Duration) -> String {
    let deadline = Instant::now() + dur;
    let mut acc = String::new();
    while Instant::now() < deadline {
        if let Ok(ev) = rx.recv_timeout(Duration::from_millis(100)) {
            if let SessionEvent::Output { data, .. } = ev {
                acc.push_str(&String::from_utf8_lossy(&data));
                if acc.contains(needle) {
                    break;
                }
            }
        }
    }
    acc
}

fn wait_transfer_done(rx: &flume::Receiver<SessionEvent>, id: Uuid, dur: Duration) -> String {
    let deadline = Instant::now() + dur;
    while Instant::now() < deadline {
        if let Ok(SessionEvent::TransferProgress { transfer_id, status, .. }) =
            rx.recv_timeout(Duration::from_millis(100))
        {
            if transfer_id == id && (status == "done" || status == "failed" || status == "cancelled") {
                return status;
            }
        }
    }
    "timeout".into()
}

fn wait_disconnect(rx: &flume::Receiver<SessionEvent>, sid: Uuid, dur: Duration) -> bool {
    let deadline = Instant::now() + dur;
    while Instant::now() < deadline {
        if let Ok(SessionEvent::Disconnected { session_id, .. }) =
            rx.recv_timeout(Duration::from_millis(100))
        {
            if session_id == sid {
                return true;
            }
        }
    }
    false
}

fn read_conn_count(path: &std::path::Path) -> u32 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

#[test]
#[ignore = "needs Python+paramiko+ssh-keygen; run with --ignored"]
fn strict_host_key_rejects_unknown_then_trust_allows() {
    let Some(server) = start_server() else {
        eprintln!("SKIP: python/paramiko/ssh-keygen unavailable");
        return;
    };
    let kh = std::env::temp_dir().join(format!("kh-{}.json", Uuid::new_v4()));
    let mut mgr = SessionManager::new().with_known_hosts_path(kh.clone());
    let conn = conn_for(server.ssh_port, &server.key);

    // First contact under Strict → unknown host key error (no silent trust).
    let err = mgr.connect(&conn, KnownHostsPolicy::Strict).unwrap_err();
    let msg = format!("{err:?}");
    assert!(msg.contains("HostKeyUnknown"), "expected HostKeyUnknown, got {msg}");
    assert_eq!(mgr.session_count(), 0, "failed connect must not leave a zombie session");

    // Trust (persist), then Strict must succeed.
    let fp = match err {
        ssh_core::CoreError::HostKeyUnknown { fingerprint, host } => {
            let mut file = ssh_core::load_known_hosts(&kh).unwrap();
            ssh_core::upsert_entry(&mut file, ssh_core::KnownHostEntry {
                host,
                fingerprint: fingerprint.clone(),
                key_type: "test".into(),
            });
            ssh_core::save_known_hosts(&kh, &file).unwrap();
            fingerprint
        }
        _ => unreachable!(),
    };
    assert!(fp.starts_with("SHA256:"));
    let sid = mgr.connect(&conn, KnownHostsPolicy::Strict).expect("trusted connect");
    assert_eq!(mgr.session_count(), 1);
    mgr.disconnect(sid).unwrap();
    let _ = server;
}

/// Build a connection to the server named by MOMO_REAL_SERVER (password from
/// ~/.ssh/mcp-hosts.json). Returns None to skip. Also returns a cleanup cred id.
fn real_conn() -> Option<(Connection, Option<String>)> {
    let name = env("MOMO_REAL_SERVER")?;
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    let cfg = PathBuf::from(home).join(".ssh").join("mcp-hosts.json");
    let data = std::fs::read_to_string(&cfg).ok()?;
    let arr: serde_json::Value = serde_json::from_str(&data).ok()?;
    let entry = arr.as_array()?.iter().find(|e| e["name"].as_str() == Some(name.as_str()))?.clone();
    let host = entry["host"].as_str()?.to_string();
    let port = entry["port"].as_u64()? as u16;
    let user = entry["username"].as_str()?.to_string();
    let pw = entry["password"].as_str()?.to_string();
    let cid = format!("mshell/realtest-{}/password", Uuid::new_v4());
    ssh_core::creds::set_secret(&cid, &pw).ok()?;
    Some((
        Connection {
            id: Uuid::new_v4(), name: "real".into(), host, port,
            protocol: ConnectionProtocol::Ssh, username: user,
            auth: AuthMethod::Password { credential_id: cid.clone() },
            group: None, tags: vec![], jump_host: None, tunnels: vec![],
            source: ConnectionSource::Manual, last_connected: None, notes: None,
            serial_config: None, on_connect: None,
        },
        Some(cid),
    ))
}

/// Regression for "Unable to send FXP_*": the dedicated SFTP session must stay
/// alive across an idle gap (keepalive), then still open files.
#[test]
#[ignore = "needs a real server; set MOMO_REAL_SERVER — takes ~45s (idle wait)"]
fn real_server_sftp_survives_idle() {
    let Some((conn, cleanup)) = real_conn() else {
        eprintln!("SKIP: set MOMO_REAL_SERVER");
        return;
    };
    let kh = std::env::temp_dir().join(format!("kh-idle-{}.json", Uuid::new_v4()));
    let mut mgr = SessionManager::new().with_known_hosts_path(kh);
    let sid = mgr.connect(&conn, KnownHostsPolicy::AcceptAll).expect("connect");

    // First op establishes the dedicated SFTP session.
    let l1 = mgr.sftp_list(sid, "/".into()).expect("list before idle");
    println!("[ok] list before idle: {} entries", l1.len());

    println!("[..] idling 40s (crosses 2+ keepalive intervals)…");
    std::thread::sleep(Duration::from_secs(40));

    // After idle: list + FXP_OPEN (read/write) must still work.
    let l2 = mgr.sftp_list(sid, "/".into()).expect("list AFTER idle");
    println!("[ok] list after idle: {} entries", l2.len());
    let cf = format!("/tmp/momo_idle_{}.txt", Uuid::new_v4());
    mgr.sftp_write(sid, cf.clone(), b"idle-ok".to_vec()).expect("FXP write after idle");
    let back = mgr.sftp_read(sid, cf.clone()).expect("FXP read after idle");
    assert_eq!(back, b"idle-ok");
    println!("[ok] FXP_OPEN read/write works after idle");
    let _ = mgr.sftp_rm(sid, cf);

    mgr.disconnect(sid).ok();
    if let Some(cid) = cleanup {
        let _ = ssh_core::creds::delete_secret(&cid);
    }
    println!("[PASS] real_server_sftp_survives_idle");
}

/// Full end-to-end run against a REAL SSH server (not the paramiko harness).
/// Set: MOMO_REAL_HOST, MOMO_REAL_PORT, MOMO_REAL_USER, MOMO_REAL_KEY (private
/// key path). Exercises the isolated-session refactor on a live box.
#[test]
#[ignore = "needs a real server; set MOMO_REAL_* and run with --ignored"]
fn real_server_full_session() {
    let kh = std::env::temp_dir().join(format!("kh-real-{}.json", Uuid::new_v4()));
    let (mut mgr, rx) = SessionManager::create();
    mgr.set_known_hosts_path(kh);

    // Auth source: either a named entry in ~/.ssh/mcp-hosts.json (password, read
    // in-process — never on a command line), or explicit MOMO_REAL_* + key.
    let mut cleanup_cred: Option<String> = None;
    let (host, port, user, auth) = if let Some(name) = env("MOMO_REAL_SERVER") {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .expect("home dir");
        let cfg = PathBuf::from(home).join(".ssh").join("mcp-hosts.json");
        let data = std::fs::read_to_string(&cfg).expect("read mcp-hosts.json");
        let arr: serde_json::Value = serde_json::from_str(&data).expect("parse mcp-hosts.json");
        let entry = arr
            .as_array()
            .and_then(|a| a.iter().find(|e| e["name"].as_str() == Some(name.as_str())))
            .unwrap_or_else(|| panic!("server '{name}' not in mcp-hosts.json"));
        let host = entry["host"].as_str().unwrap().to_string();
        let port = entry["port"].as_u64().unwrap() as u16;
        let user = entry["username"].as_str().unwrap().to_string();
        let pw = entry["password"].as_str().unwrap().to_string();
        let cid = format!("mshell/realtest-{}/password", Uuid::new_v4());
        ssh_core::creds::set_secret(&cid, &pw).expect("set_secret");
        cleanup_cred = Some(cid.clone());
        (host, port, user, AuthMethod::Password { credential_id: cid })
    } else if let (Some(h), Some(p), Some(u), Some(k)) = (
        env("MOMO_REAL_HOST"),
        env("MOMO_REAL_PORT"),
        env("MOMO_REAL_USER"),
        env("MOMO_REAL_KEY"),
    ) {
        (h, p.parse::<u16>().expect("port"), u, AuthMethod::PrivateKey { path: k, passphrase_credential_id: None })
    } else {
        eprintln!("SKIP: set MOMO_REAL_SERVER (mcp-hosts.json name) or MOMO_REAL_HOST/PORT/USER/KEY");
        return;
    };
    let conn = Connection {
        id: Uuid::new_v4(),
        name: "real".into(),
        host,
        port,
        protocol: ConnectionProtocol::Ssh,
        username: user,
        auth,
        group: None,
        tags: vec![],
        jump_host: None,
        tunnels: vec![],
        source: ConnectionSource::Manual,
        last_connected: None,
        notes: None,
        serial_config: None,
        on_connect: None,
    };

    // ── connect + interactive shell echo (coalesced output path) ─────────
    let sid = mgr.connect(&conn, KnownHostsPolicy::AcceptAll).expect("connect");
    println!("[ok] connected, session={sid}");
    let chan = mgr.open_shell(sid, 80, 24).expect("open_shell");
    mgr.write(sid, chan, b"echo MOMO_MARK_42\n".to_vec()).unwrap();
    let echoed = wait_output(&rx, "MOMO_MARK_42", Duration::from_secs(8));
    assert!(echoed.contains("MOMO_MARK_42"), "shell echo missing: {echoed:?}");
    println!("[ok] interactive shell echo");

    // ── exec on its own channel ─────────────────────────────────────────
    let uname = mgr.exec(sid, "uname -s".into()).expect("exec");
    assert!(uname.contains("Linux"), "unexpected uname: {uname:?}");
    println!("[ok] exec uname -s => {}", uname.trim());

    // ── SFTP on its OWN separate connection ─────────────────────────────
    let list = mgr.sftp_list(sid, "/".into()).expect("sftp_list");
    assert!(list.iter().any(|e| e.name == "etc"), "/etc missing in listing");
    println!("[ok] sftp list / ({} entries)", list.len());

    // Repro: repeated realpath calls (the file browser calls realpath on every
    // navigation). Watch for "Unable to send SYMLINK/READLINK command".
    for p in [".", "/", "/etc", "/tmp", "/", "/etc"] {
        match mgr.sftp_realpath(sid, p.to_string()) {
            Ok(r) => println!("[ok] realpath {p:?} => {r}"),
            Err(e) => println!("[FAIL] realpath {p:?} => {e}"),
        }
    }

    let remote = format!("/tmp/momo_rw_{}.txt", Uuid::new_v4());
    mgr.sftp_write(sid, remote.clone(), b"momo-sftp-xyz".to_vec()).expect("sftp_write");
    assert_eq!(mgr.sftp_read(sid, remote.clone()).expect("sftp_read"), b"momo-sftp-xyz");
    println!("[ok] sftp write+read roundtrip");

    // chmod repro: apply a mode, verify via `stat -c %a`.
    let cf = format!("/tmp/momo_chmod_{}.txt", Uuid::new_v4());
    mgr.sftp_write(sid, cf.clone(), b"x".to_vec()).unwrap();
    mgr.sftp_chmod(sid, cf.clone(), 0o600).expect("chmod 600");
    let m1 = mgr.exec(sid, format!("stat -c %a {cf}")).unwrap_or_default();
    println!("[chmod] after 600 => stat %a = {}", m1.trim());
    mgr.sftp_chmod(sid, cf.clone(), 0o744).expect("chmod 744");
    let m2 = mgr.exec(sid, format!("stat -c %a {cf}")).unwrap_or_default();
    println!("[chmod] after 744 => stat %a = {}", m2.trim());
    let _ = mgr.sftp_rm(sid, cf);

    // upload + download roundtrip
    let up = std::env::temp_dir().join(format!("momo-up-{}.bin", Uuid::new_v4()));
    let payload: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&up, &payload).unwrap();
    let rup = format!("/tmp/momo_up_{}.bin", Uuid::new_v4());
    let tid = mgr.sftp_upload(sid, up.clone(), rup.clone()).expect("upload");
    assert_eq!(wait_transfer_done(&rx, tid, Duration::from_secs(20)), "done", "upload failed");
    let dl = std::env::temp_dir().join(format!("momo-dl-{}.bin", Uuid::new_v4()));
    let tid = mgr.sftp_download(sid, rup.clone(), dl.clone()).expect("download");
    assert_eq!(wait_transfer_done(&rx, tid, Duration::from_secs(20)), "done", "download failed");
    assert_eq!(std::fs::read(&dl).unwrap(), payload, "roundtrip payload mismatch");
    println!("[ok] sftp upload+download 200KB roundtrip");
    let _ = mgr.sftp_rm(sid, remote);
    let _ = mgr.sftp_rm(sid, rup);

    // ── recursive folder upload + download ───────────────────────────────
    let ldir = std::env::temp_dir().join(format!("momo-dir-{}", Uuid::new_v4()));
    std::fs::create_dir_all(ldir.join("sub")).unwrap();
    std::fs::write(ldir.join("a.txt"), b"alpha").unwrap();
    std::fs::write(ldir.join("sub").join("b.txt"), b"bravo-in-sub").unwrap();
    let rdir = format!("/tmp/momo_dir_{}", Uuid::new_v4());
    let tid = mgr.sftp_upload(sid, ldir.clone(), rdir.clone()).expect("upload_dir");
    assert_eq!(wait_transfer_done(&rx, tid, Duration::from_secs(30)), "done", "dir upload failed");
    let ddir = std::env::temp_dir().join(format!("momo-ddir-{}", Uuid::new_v4()));
    let tid = mgr.sftp_download(sid, rdir.clone(), ddir.clone()).expect("download_dir");
    assert_eq!(wait_transfer_done(&rx, tid, Duration::from_secs(30)), "done", "dir download failed");
    assert_eq!(std::fs::read(ddir.join("a.txt")).unwrap(), b"alpha");
    assert_eq!(std::fs::read(ddir.join("sub").join("b.txt")).unwrap(), b"bravo-in-sub");
    println!("[ok] sftp recursive folder upload+download");
    let _ = mgr.exec(sid, format!("rm -rf {rdir}"));

    // ── local port-forward on its OWN connection → the server's sshd ───────
    // Detect sshd's actual listening port (it isn't always 22 internally).
    let sshd_port: u16 = mgr
        .exec(sid, "ss -tlnpH 2>/dev/null | grep -i ssh | grep -oE ':[0-9]+ ' | grep -oE '[0-9]+' | head -1".into())
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .or_else(|| mgr.exec(sid, "awk '/^Port /{print $2; exit}' /etc/ssh/sshd_config".into()).ok().and_then(|s| s.trim().parse().ok()))
        .unwrap_or(22);
    println!("[..] tunnel target = 127.0.0.1:{sshd_port} (sshd)");
    let local_port = free_port();
    let tunnel = TunnelConfig {
        id: Uuid::new_v4(),
        name: "L".into(),
        auto_start: false,
        kind: TunnelType::Local {
            local_host: "127.0.0.1".into(),
            local_port,
            remote_host: "127.0.0.1".into(),
            remote_port: sshd_port,
        },
    };
    mgr.tunnel_start(sid, tunnel).expect("tunnel_start");
    std::thread::sleep(Duration::from_millis(800));
    let mut s = TcpStream::connect(("127.0.0.1", local_port)).expect("connect via tunnel");
    s.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).expect("tunnel read");
    let banner = String::from_utf8_lossy(&buf[..n]);
    assert!(banner.starts_with("SSH-2.0"), "tunnel did not reach sshd, got: {banner:?}");
    println!("[ok] tunnel forward → sshd banner: {}", banner.trim());

    // ── shell close (`exit`) → Disconnected fires, no zombie (#1) ────────
    mgr.write(sid, chan, b"exit\n".to_vec()).unwrap();
    assert!(
        wait_disconnect(&rx, sid, Duration::from_secs(8)),
        "worker did not emit Disconnected after shell closed"
    );
    println!("[ok] shell exit → Disconnected");
    let _ = mgr.disconnect(sid);
    if let Some(cid) = cleanup_cred {
        let _ = ssh_core::creds::delete_secret(&cid);
    }
    println!("[PASS] real_server_full_session");
}

#[test]
#[ignore = "needs Python+paramiko+ssh-keygen; run with --ignored"]
fn full_session_shell_exec_sftp_tunnel_isolated() {
    let Some(server) = start_server() else {
        eprintln!("SKIP: python/paramiko/ssh-keygen unavailable");
        return;
    };
    let kh = std::env::temp_dir().join(format!("kh-{}.json", Uuid::new_v4()));
    let (mut mgr, rx) = SessionManager::create();
    mgr.set_known_hosts_path(kh);
    let conn = conn_for(server.ssh_port, &server.key);

    // ── connect + shell echo ────────────────────────────────────────────
    let sid = mgr.connect(&conn, KnownHostsPolicy::AcceptAll).expect("connect");
    let chan = mgr.open_shell(sid, 80, 24).expect("open_shell");
    let banner = wait_output(&rx, "mshell-test-shell", Duration::from_secs(5));
    assert!(banner.contains("mshell-test-shell"), "no shell banner: {banner:?}");
    mgr.write(sid, chan, b"hello123\n".to_vec()).unwrap();
    let echoed = wait_output(&rx, "hello123", Duration::from_secs(5));
    assert!(echoed.contains("hello123"), "shell did not echo input: {echoed:?}");

    // ── exec (has its own channel; timeout/cap path) ────────────────────
    let out = mgr.exec(sid, "whoami".into()).expect("exec");
    assert!(out.contains("EXEC:whoami"), "unexpected exec output: {out:?}");

    let after_interactive = read_conn_count(&server.count_file);
    assert_eq!(after_interactive, 1, "interactive session should be a single connection");

    // ── SFTP: list / read / write / download / upload ───────────────────
    let list = mgr.sftp_list(sid, ".".into()).expect("sftp_list");
    assert!(list.iter().any(|e| e.name == "greeting.txt"), "greeting.txt missing: {list:?}");

    let read = mgr.sftp_read(sid, "/greeting.txt".into()).expect("sftp_read");
    assert_eq!(read, b"hello-from-server\n");

    mgr.sftp_write(sid, "/written.txt".into(), b"written-data".to_vec()).expect("sftp_write");
    let back = mgr.sftp_read(sid, "/written.txt".into()).expect("read back");
    assert_eq!(back, b"written-data");

    // SFTP must run on its own separate SSH connection.
    let after_sftp = read_conn_count(&server.count_file);
    assert!(after_sftp >= 2, "SFTP should open a separate connection (count={after_sftp})");

    // download greeting.txt → local
    let dl = std::env::temp_dir().join(format!("dl-{}.txt", Uuid::new_v4()));
    let tid = mgr.sftp_download(sid, "/greeting.txt".into(), dl.clone()).expect("download");
    assert_eq!(wait_transfer_done(&rx, tid, Duration::from_secs(10)), "done");
    assert_eq!(std::fs::read(&dl).unwrap(), b"hello-from-server\n");

    // upload a local file → remote, verify on server disk
    let up = std::env::temp_dir().join(format!("up-{}.txt", Uuid::new_v4()));
    std::fs::write(&up, b"uploaded-bytes-xyz").unwrap();
    let tid = mgr.sftp_upload(sid, up.clone(), "/uploaded.txt".into()).expect("upload");
    assert_eq!(wait_transfer_done(&rx, tid, Duration::from_secs(10)), "done");
    assert_eq!(std::fs::read(server.root.join("uploaded.txt")).unwrap(), b"uploaded-bytes-xyz");

    // ── local port-forward on its own connection ────────────────────────
    let local_port = free_port();
    let tunnel = TunnelConfig {
        id: Uuid::new_v4(),
        name: "L".into(),
        auto_start: false,
        kind: TunnelType::Local {
            local_host: "127.0.0.1".into(),
            local_port,
            remote_host: "127.0.0.1".into(),
            remote_port: server.echo_port,
        },
    };
    mgr.tunnel_start(sid, tunnel).expect("tunnel_start");
    std::thread::sleep(Duration::from_millis(300)); // listener bind
    let mut s = TcpStream::connect(("127.0.0.1", local_port)).expect("connect tunnel");
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(b"ping").unwrap();
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).expect("tunnel read");
    assert_eq!(&buf[..n], b"ECHO:ping", "tunnel did not forward to echo server");

    let after_tunnel = read_conn_count(&server.count_file);
    assert!(after_tunnel >= 3, "tunnel should open a separate connection (count={after_tunnel})");

    // ── shell close (`exit`) → session ends, Disconnected fires (#1) ─────
    mgr.write(sid, chan, b"exit\n".to_vec()).unwrap();
    assert!(
        wait_disconnect(&rx, sid, Duration::from_secs(8)),
        "worker did not emit Disconnected after shell closed"
    );

    // ── explicit disconnect is clean / idempotent ───────────────────────
    let _ = mgr.disconnect(sid);
    let _ = server;
}
