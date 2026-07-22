//! SFTP helpers for LiveSession workers.
//!
//! All functions run on the session worker thread that owns the `ssh2::Session`.
//! Remote paths are treated as Unix-style strings (forward slashes) so Windows
//! hosts do not inject backslashes via [`std::path::Path::join`].

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use protocol::RemoteEntry;
use ssh2::{Session, Sftp};

use crate::error::CoreError;
use crate::transfer::{self, TransferQueue};

/// Open an SFTP subsystem on an authenticated session.
///
/// `sess` should be in **blocking** mode for the channel handshake.
pub fn open_sftp(sess: &Session) -> Result<Sftp, CoreError> {
    Ok(sess.sftp()?)
}

/// Resolve a remote path (e.g. `"."`) to an absolute path string.
pub fn realpath(sftp: &Sftp, path: &str) -> Result<String, CoreError> {
    let p = sftp.realpath(Path::new(path))?;
    Ok(remote_path_to_string(&p))
}

/// List directory entries at `path` (`.` and `..` already filtered by ssh2).
pub fn list(sftp: &Sftp, path: &str) -> Result<Vec<RemoteEntry>, CoreError> {
    let entries = sftp.readdir(Path::new(path))?;
    let mut out = Vec::with_capacity(entries.len());
    for (entry_path, stat) in entries {
        let full = remote_path_to_string(&entry_path);
        let name = entry_name(&full);
        out.push(RemoteEntry {
            name,
            path: full,
            is_dir: stat.is_dir(),
            size: stat.size.unwrap_or(0),
            modified: stat.mtime.map(|t| t as i64),
        });
    }
    // Directories first, then name (case-insensitive-ish via default Ord on bytes).
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

/// Create a directory with mode `0o755`.
pub fn mkdir(sftp: &Sftp, path: &str) -> Result<(), CoreError> {
    sftp.mkdir(Path::new(path), 0o755)?;
    Ok(())
}

/// Remove a file or empty directory.
pub fn remove(sftp: &Sftp, path: &str) -> Result<(), CoreError> {
    let p = Path::new(path);
    // Prefer stat to choose unlink vs rmdir; fall back to unlink then rmdir.
    match sftp.stat(p) {
        Ok(st) if st.is_dir() => sftp.rmdir(p)?,
        Ok(_) => sftp.unlink(p)?,
        Err(_) => {
            if sftp.unlink(p).is_err() {
                sftp.rmdir(p)?;
            }
        }
    }
    Ok(())
}

/// Rename / move a remote filesystem object.
pub fn rename(sftp: &Sftp, from: &str, to: &str) -> Result<(), CoreError> {
    sftp.rename(Path::new(from), Path::new(to), None)?;
    Ok(())
}

/// Normalize a PathBuf that may contain Windows separators into a remote path string.
fn remote_path_to_string(path: &Path) -> String {
    // Prefer lossy UTF-8; replace `\` so Windows Path::join artifacts stay Unix-like.
    path.to_string_lossy().replace('\\', "/")
}

fn entry_name(full_path: &str) -> String {
    full_path
        .rsplit('/')
        .find(|s| !s.is_empty())
        .unwrap_or(full_path)
        .to_string()
}

/// Join parent + child for remote Unix paths.
#[allow(dead_code)]
pub fn join_remote(parent: &str, name: &str) -> String {
    if parent.is_empty() || parent == "/" {
        format!("/{}", name.trim_start_matches('/'))
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

/// Convenience for callers that need a PathBuf for intermediate ops.
#[allow(dead_code)]
pub fn remote_pathbuf(path: &str) -> PathBuf {
    PathBuf::from(path.replace('\\', "/"))
}

/// Read a remote file into memory (base64-encoded). Best for small config files.
pub fn read_text(sftp: &Sftp, remote_path: &str) -> Result<Vec<u8>, CoreError> {
    let mut remote = sftp.open(Path::new(remote_path))?;
    let mut buf = Vec::new();
    remote.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Write in-memory content to a remote file. Overwrites existing content.
pub fn write_text(sftp: &Sftp, remote_path: &str, data: &[u8]) -> Result<(), CoreError> {
    use std::io::Write;
    let mut remote = sftp.create(Path::new(remote_path))?;
    remote.write_all(data)?;
    remote.flush()?;
    Ok(())
}

/// Change permissions on a remote file/directory (chmod mode).
pub fn chmod(sftp: &Sftp, path: &str, mode: u32) -> Result<(), CoreError> {
    let mut stat = sftp.stat(Path::new(path))?;
    stat.perm = Some(mode);
    sftp.setstat(Path::new(path), stat)?;
    Ok(())
}

/// Result of a chunked transfer (for status event mapping).
#[derive(Debug)]
pub enum TransferOutcome {
    Done { bytes: u64, total: Option<u64> },
    Cancelled { bytes: u64, total: Option<u64> },
}

/// Upload local file → remote path with cooperative cancel + progress callback.
///
/// `on_progress(bytes, total)` is invoked about every [`transfer::PROGRESS_INTERVAL`]
/// bytes and once at completion (or cancel).
pub fn upload<F>(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &str,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<TransferOutcome, CoreError>
where
    F: FnMut(u64, Option<u64>),
{
    let mut local = File::open(local_path)?;
    let total = local.metadata().ok().map(|m| m.len());
    let mut remote = sftp.create(Path::new(remote_path))?;
    copy_loop(
        &mut local,
        &mut remote,
        total,
        cancel,
        &mut on_progress,
    )
}

/// Download remote path → local file with cooperative cancel + progress callback.
pub fn download<F>(
    sftp: &Sftp,
    remote_path: &str,
    local_path: &Path,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<TransferOutcome, CoreError>
where
    F: FnMut(u64, Option<u64>),
{
    let remote_file = sftp.open(Path::new(remote_path))?;
    let total = sftp
        .stat(Path::new(remote_path))
        .ok()
        .and_then(|st| st.size);
    // Create parent dirs if needed.
    if let Some(parent) = local_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let mut local = File::create(local_path)?;
    let mut remote = remote_file;
    copy_loop(
        &mut remote,
        &mut local,
        total,
        cancel,
        &mut on_progress,
    )
}

fn copy_loop<R, W, F>(
    reader: &mut R,
    writer: &mut W,
    total: Option<u64>,
    cancel: &AtomicBool,
    on_progress: &mut F,
) -> Result<TransferOutcome, CoreError>
where
    R: Read,
    W: Write,
    F: FnMut(u64, Option<u64>),
{
    let mut buf = vec![0u8; transfer::CHUNK_SIZE];
    let mut bytes: u64 = 0;
    let mut last_report: u64 = 0;

    // Initial progress so UI shows the job immediately.
    on_progress(0, total);

    loop {
        if TransferQueue::is_cancelled(cancel) {
            let _ = writer.flush();
            return Ok(TransferOutcome::Cancelled { bytes, total });
        }

        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        bytes += n as u64;

        if bytes - last_report >= transfer::PROGRESS_INTERVAL {
            on_progress(bytes, total);
            last_report = bytes;
        }
    }

    writer.flush()?;
    on_progress(bytes, total);
    Ok(TransferOutcome::Done { bytes, total })
}
