# mshell

轻量 Windows SSH 客户端 — Tauri 2 + React + Rust。

多标签终端、SFTP 编辑、隧道、命令面板、多协议支持。

## 功能

| 能力 | 说明 |
|------|------|
| **协议** | SSH · Telnet · 串口 (COM) · 本地终端 (cmd/PowerShell) |
| **终端** | 多标签、xterm.js、断线重连、搜索 (Ctrl+F)、剪贴板粘贴 |
| **SFTP** | 文件浏览、右键上传/下载/删除/重命名、拖拽上传、批量选择、传输队列 |
| **编辑器** | 多文件标签、语法高亮（One Dark / Dracula / Nord …）、50+ 语言、查找替换 |
| **隧道** | 本地/远程/动态端口转发、运行态起停、一键复制端口 |
| **命令面板** | Ctrl+P 打开连接 / 切视图 / 切换主题 |
| **快捷命令** | 保存常用命令，终端底部一键发送 |
| **凭据** | Windows Credential Manager、密码/密钥/Agent/证书 |
| **跳板机** | ProxyJump 多跳 |
| **主机密钥** | unknown/changed 指纹确认、持久化信任 |
| **主题** | 深色/浅色分开控制、代码高亮 8 套配色 |
| **导出** | 连接 JSON（凭据留在 Credential Manager）|

## 环境

| Tool | 版本 |
|------|------|
| Node.js | 20+ |
| Rust | stable, x86_64-pc-windows-msvc |
| VS Build Tools | Desktop development with C++（libssh2 需要） |

## 开发

```bash
npm install
npm run tauri dev        # 热更新开发
scripts/build.sh         # 构建 + 测试
npm run tauri build      # 打包 MSI / NSIS
npm test                 # 前端测试
cargo test -p mshell  # Rust 测试
```

## 快捷键

| 按键 | 功能 |
|------|------|
| Ctrl+P / Ctrl+K | 命令面板 |
| ? / F1 | 快捷键帮助 |
| Ctrl+F (终端) | 终端搜索 |
| Ctrl+V (终端) | 粘贴 |
| Ctrl+Tab / PgUp/PgDown | 切换会话标签 |
| Ctrl+F / Ctrl+H (编辑器) | 查找 / 替换 |

## 打包产物

- `target/release/mshell.exe` — 可执行文件
- `target/release/bundle/msi/mshell_*.msi` — 安装包
- `target/release/bundle/nsis/mshell_*-setup.exe` — 安装包

## 工作区

| 路径 | 职责 |
|------|------|
| `src/` | React 前端 (Vite) |
| `crates/app` | Tauri 壳 + 命令胶水 |
| `crates/protocol` | 共享 DTO |
| `crates/store` | 本地 JSON 持久化 |
| `crates/ssh-core` | SSH / SFTP / 隧道 / 多协议 |

## License

MIT
