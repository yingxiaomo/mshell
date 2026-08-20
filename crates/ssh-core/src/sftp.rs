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
            mode: stat.perm.map(|p| p & 0o7777),
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

// ============================================================================
// Recursive directory transfers
// ============================================================================

/// Create a remote directory and all missing ancestors (best-effort; existing
/// dirs are ignored).
fn mkdir_p(sftp: &Sftp, path: &str) {
    let mut cur = String::new();
    for part in path.split('/') {
        if part.is_empty() {
            if cur.is_empty() {
                cur.push('/'); // preserve a leading slash (absolute path)
            }
            continue;
        }
        if !cur.is_empty() && !cur.ends_with('/') {
            cur.push('/');
        }
        cur.push_str(part);
        let _ = sftp.mkdir(Path::new(&cur), 0o755);
    }
}

/// Walk a local directory, collecting (local file, remote path) pairs and the
/// total byte size. `remote_base` is the destination directory.
fn collect_local(
    local_dir: &Path,
    remote_base: &str,
    out: &mut Vec<(PathBuf, String)>,
    total: &mut u64,
) -> Result<(), CoreError> {
    for entry in std::fs::read_dir(local_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let remote = if remote_base.is_empty() || remote_base == "/" {
            format!("/{}", name.trim_start_matches('/'))
        } else if remote_base.ends_with('/') {
            format!("{remote_base}{name}")
        } else {
            format!("{remote_base}/{name}")
        };
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_local(&entry.path(), &remote, out, total)?;
        } else if ft.is_file() {
            *total += entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push((entry.path(), remote));
        }
        // symlinks / specials are skipped
    }
    Ok(())
}

/// Validate an SFTP entry name for safe local join during directory download.
///
/// Only plain file/dir names are allowed: must be non-empty, not "." or "..",
/// and must not contain path separators (`/`, `\`), drive letters, or any other
/// component separator. This blocks malicious servers from writing outside the
/// download target directory (path traversal) via names like `../evil` or
/// `a/../../evil`.
fn safe_entry_name(name: &str) -> Result<(), CoreError> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(CoreError::Other(format!(
            "拒绝下载目录条目（不安全名称）：{name:?}"
        )));
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err(CoreError::Other(format!(
            "拒绝下载目录条目（含路径分隔符）：{name:?}"
        )));
    }
    // Windows normalizes trailing dots/spaces away when creating a file, so
    // `"con "`, `"con."` or `"foo. "` collapse onto device names (or a shorter
    // name) and can then collide with or shadow real files. Trim them before
    // checking reserved names; a name that is only dots/spaces is also unsafe.
    let trimmed = name.trim_end_matches([' ', '.']);
    if trimmed.is_empty() {
        return Err(CoreError::Other(format!(
            "拒绝下载目录条目（名称仅由空白/点组成）：{name:?}"
        )));
    }
    // Reject hidden Windows device names / reserved names that shadow local files.
    let stem = trimmed.split('.').next().unwrap_or(trimmed).to_ascii_uppercase();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        return Err(CoreError::Other(format!(
            "拒绝下载目录条目（Windows 保留名称）：{name:?}"
        )));
    }
    Ok(())
}

/// Walk a remote directory via SFTP, collecting (remote file, local path) pairs
/// and total size. `depth` bounds recursion so a malicious/buggy server cannot
/// construct an unbounded directory tree and blow the stack while collecting.
const MAX_COLLECT_DEPTH: u32 = 64;

fn collect_remote(
    sftp: &Sftp,
    remote_dir: &str,
    local_base: &Path,
    depth: u32,
    out: &mut Vec<(String, PathBuf)>,
    total: &mut u64,
) -> Result<(), CoreError> {
    if depth > MAX_COLLECT_DEPTH {
        return Err(CoreError::Other(format!(
            "远端目录嵌套超过 {MAX_COLLECT_DEPTH} 层，已中止：{remote_dir}"
        )));
    }
    for (entry_path, stat) in sftp.readdir(Path::new(remote_dir))? {
        let full = remote_path_to_string(&entry_path);
        let name = entry_name(&full);
        if name == "." || name == ".." {
            continue;
        }
        // Path-traversal guard: never trust server-provided entry names.
        safe_entry_name(&name)?;
        let local = local_base.join(&name);
        if stat.is_dir() {
            collect_remote(sftp, &full, &local, depth + 1, out, total)?;
        } else {
            *total += stat.size.unwrap_or(0);
            out.push((full, local));
        }
    }
    Ok(())
}

/// Copy one file's bytes into a running cumulative counter, reporting progress.
/// Returns `false` if cancelled mid-file.
fn copy_file_cumulative<R, W, F>(
    reader: &mut R,
    writer: &mut W,
    cancel: &AtomicBool,
    done: &mut u64,
    total: u64,
    last_report: &mut u64,
    on_progress: &mut F,
) -> Result<bool, CoreError>
where
    R: Read,
    W: Write,
    F: FnMut(u64, Option<u64>),
{
    let mut buf = vec![0u8; transfer::CHUNK_SIZE];
    loop {
        if TransferQueue::is_cancelled(cancel) {
            let _ = writer.flush();
            return Ok(false);
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        *done += n as u64;
        if *done - *last_report >= transfer::PROGRESS_INTERVAL {
            on_progress(*done, Some(total));
            *last_report = *done;
        }
    }
    writer.flush()?;
    Ok(true)
}

/// Recursively upload a local directory tree to `remote_dir`.
pub fn upload_dir<F>(
    sftp: &Sftp,
    local_dir: &Path,
    remote_dir: &str,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<TransferOutcome, CoreError>
where
    F: FnMut(u64, Option<u64>),
{
    let mut files = Vec::new();
    let mut total = 0u64;
    collect_local(local_dir, remote_dir, &mut files, &mut total)?;
    on_progress(0, Some(total));
    mkdir_p(sftp, remote_dir);

    let (mut done, mut last) = (0u64, 0u64);
    for (local_file, remote_path) in &files {
        if TransferQueue::is_cancelled(cancel) {
            return Ok(TransferOutcome::Cancelled { bytes: done, total: Some(total) });
        }
        if let Some(idx) = remote_path.rfind('/') {
            mkdir_p(sftp, &remote_path[..idx]);
        }
        let mut local = File::open(local_file)?;
        let mut remote = sftp.create(Path::new(remote_path))?;
        if !copy_file_cumulative(&mut local, &mut remote, cancel, &mut done, total, &mut last, &mut on_progress)? {
            return Ok(TransferOutcome::Cancelled { bytes: done, total: Some(total) });
        }
    }
    on_progress(done, Some(total));
    Ok(TransferOutcome::Done { bytes: done, total: Some(total) })
}

/// Recursively download a remote directory tree to `local_dir`.
pub fn download_dir<F>(
    sftp: &Sftp,
    remote_dir: &str,
    local_dir: &Path,
    cancel: &AtomicBool,
    mut on_progress: F,
) -> Result<TransferOutcome, CoreError>
where
    F: FnMut(u64, Option<u64>),
{
    let mut files = Vec::new();
    let mut total = 0u64;
    collect_remote(sftp, remote_dir, local_dir, 0, &mut files, &mut total)?;
    on_progress(0, Some(total));
    std::fs::create_dir_all(local_dir)?;

    let (mut done, mut last) = (0u64, 0u64);
    for (remote_file, local_path) in &files {
        if TransferQueue::is_cancelled(cancel) {
            return Ok(TransferOutcome::Cancelled { bytes: done, total: Some(total) });
        }
        if let Some(parent) = local_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut remote = sftp.open(Path::new(remote_file))?;
        let mut local = File::create(local_path)?;
        if !copy_file_cumulative(&mut remote, &mut local, cancel, &mut done, total, &mut last, &mut on_progress)? {
            return Ok(TransferOutcome::Cancelled { bytes: done, total: Some(total) });
        }
    }
    on_progress(done, Some(total));
    Ok(TransferOutcome::Done { bytes: done, total: Some(total) })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_entry_name_accepts_plain_names() {
        assert!(safe_entry_name("report.txt").is_ok());
        assert!(safe_entry_name("数据-2026.md").is_ok());
        assert!(safe_entry_name("a b c").is_ok());
        assert!(safe_entry_name("normal dir").is_ok());
    }

    #[test]
    fn safe_entry_name_rejects_navigation_and_separators() {
        assert!(safe_entry_name("").is_err());
        assert!(safe_entry_name(".").is_err());
        assert!(safe_entry_name("..").is_err());
        assert!(safe_entry_name("../evil").is_err());
        assert!(safe_entry_name("a/../../evil").is_err());
        assert!(safe_entry_name("..\\win").is_err());
        assert!(safe_entry_name("c:evil").is_err());
        assert!(safe_entry_name("1:2").is_err());
    }

    #[test]
    fn safe_entry_name_rejects_windows_reserved_variants() {
        for n in ["CON", "con", "con.txt", "con.", "con ", "NUL", "nul.txt", "nul.", "nul ", "COM1", "com1.txt", "LPT9", "lpt9."] {
            assert!(safe_entry_name(n).is_err(), "expected reject for {n:?}");
        }
        // Only-dots/spaces names collapse to nothing on Windows — unsafe.
        assert!(safe_entry_name("   ").is_err());
        assert!(safe_entry_name("...").is_err());
        assert!(safe_entry_name(". . .").is_err());
    }

    #[test]
    fn safe_entry_name_keeps_legal_dotted_names() {
        assert!(safe_entry_name("console.log").is_ok(), "console* is not a device name");
        assert!(safe_entry_name("community.txt").is_ok());
        assert!(safe_entry_name("com10.txt").is_ok(), "COM10 is not reserved (COM1-9 only)");
        assert!(safe_entry_name("confer.md").is_ok());
        assert!(safe_entry_name("note.").is_ok(), "trailing dot on a non-reserved stem is tolerated");
    }
}
