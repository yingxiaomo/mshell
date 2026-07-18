# momoshell

Lightweight full-featured SSH client for Windows — Tauri 2 + React + Rust.

## Requirements

- Node.js 20+
- Rust stable (`x86_64-pc-windows-msvc`)
- Visual Studio Build Tools (MSVC + Windows SDK) for native crates

## Develop

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

## Workspace

| Path | Role |
|------|------|
| `src/` | React frontend (Vite) |
| `crates/app` | Tauri shell + command glue |
| `crates/protocol` | Shared DTOs (Task 2+) |
| `crates/store` | Local persistence (Task 2+) |
| `crates/ssh-core` | SSH / SFTP / tunnels (Task 2+) |

## License

MIT
