# momoshell

Lightweight full-featured SSH client for Windows — Tauri 2 + React + Rust.

轻量 Windows SSH 客户端（多标签终端、SFTP 侧栏、隧道、凭据管理）。

## Requirements / 环境

| Tool | Notes |
|------|--------|
| **Node.js** | 20+ |
| **Rust** | stable, target `x86_64-pc-windows-msvc` |
| **Visual Studio Build Tools** | MSVC C++ workload + Windows SDK（`ssh2` / `libssh2` 需要） |

Install Build Tools: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) → workload **Desktop development with C++**.

## Develop / 开发

```bash
npm install
npm run tauri dev
```

Frontend only (no native shell):

```bash
npm run dev
```

Typecheck + Vite production bundle:

```bash
npm run build
```

Rust check (workspace app package):

```bash
cargo check -p momoshell
```

## Package / 打包

Icons live under `crates/app/icons/` (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`, `icon.icns`) and are referenced from `crates/app/tauri.conf.json`.

Release build (produces installer / binary under `src-tauri` / target bundle paths used by Tauri 2):

```bash
npm run tauri build
```

Artifacts typically appear under:

- `crates/app/target/release/` — `momoshell.exe`
- `crates/app/target/release/bundle/` — MSI / NSIS (when bundle targets are enabled)

> Full `tauri build` needs the MSVC toolchain and can take several minutes on first run.

## Features (V1)

- Connection CRUD + optional `~/.ssh/config` import
- Multi-tab PTY terminal (xterm.js) with reconnect
- SFTP file sidebar + transfer progress
- Local / dynamic tunnels (and remote tunnel config)
- ProxyJump multi-hop
- Host key trust prompt (strict known_hosts; modal on unknown / changed)
- Export / import connections JSON (secrets stay in Windows Credential Manager)

### Host keys

On connect, unknown or changed host keys return a structured error; the UI shows a fingerprint modal. Trusting writes `%AppData%/momoshell/known_hosts.json`, then retries open.

### Connection export

**Settings → 导入 / 导出**:

- Default export: connection metadata only (no plaintext passwords).
- “含 credentialId” requires typing `EXPORT_SECRETS`; still does **not** dump keyring secret values — re-enter passwords after import on another machine.

## Workspace

| Path | Role |
|------|------|
| `src/` | React frontend (Vite) |
| `crates/app` | Tauri shell + command glue |
| `crates/protocol` | Shared DTOs |
| `crates/store` | Local JSON persistence |
| `crates/ssh-core` | SSH / SFTP / tunnels / known_hosts |

## License

MIT
