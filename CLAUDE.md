# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

mshell 是一个轻量 Windows SSH 客户端（Tauri 2 + React 19 + Rust），支持 SSH/Telnet/串口/本地终端、多标签 xterm.js 终端、SFTP 文件管理、内置 CodeMirror 编辑器、端口隧道、命令面板、AI 聊天等。

**命名：** 产品名、二进制、Rust 应用 crate（`crates/app`）统一为 `mshell`；目录 `src/` 是前端，`crates/` 是后端。

## 常用命令

```bash
npm install                       # 首次安装依赖
npm run tauri dev                 # 热更新开发（Vite 端口 1420）
npm run build                     # tsc --noEmit + vite build（前端类型检查 + 构建）
npm run tauri build               # 打包 MSI / NSIS 安装包
scripts/build.sh                  # 一键构建 + 测试

npm test                          # vitest run
npm run test:watch                # vitest watch
npx vitest run src/lib/__tests__/xxx.test.ts   # 运行单个测试文件
npx vitest run -t "测试名"         # 按名称过滤

cargo test -p protocol -p store -p ssh-core -p mshell --lib   # Rust 单测
cargo clippy --workspace --lib -- -D warnings                     # lint（CI 门槛）
cargo test -p ssh-core --test live_ssh -- --ignored --nocapture   # 端到端集成测试（需 Python + paramiko + ssh-keygen，见 tests/support/ssh_server.py）
```

- vitest 默认环境是 `node`；组件测试在文件内用 `@vitest-environment jsdom` docblock pragma 切换。
- 前端测试位于 `src/lib/__tests__/`。
- CI（`.github/workflows`）跑 tsc、vitest、clippy `-D warnings`、`cargo test --workspace --lib`，并在 main push / tag 时构建发布。

## 架构

### 双端数字契约（改类型必须两端同步）

`crates/protocol` 定义所有 Rust ↔ 前端的 DTO，`src/types/protocol.ts` 是**手写镜像**，两者必须保持同步：

- 所有 struct/enum 用 `#[serde(rename_all = "camelCase")]`；区分联合用 `#[serde(tag = "type", rename_all = "camelCase")]`（如 `AuthMethod`、`TunnelType`、`ConnectionSource`、`ClientError`）。
- 错误统一为 `ClientError`（tag = `"kind"`，含 `hostKeyUnknown`/`hostKeyChanged` 以便前端弹指纹确认框）。前端用 `parseClientError()` 解析（Tauri 可能把 JSON 包在普通文本里）。
- 新增/修改 DTO 时：改 `crates/protocol/src/lib.rs` + `src/types/protocol.ts`，再跑 `crates/protocol` 的 roundtrip 测试。

### 后端线程模型（核心设计）

`ssh-core` 是引擎，**每个活跃会话一个 OS 线程**，持有 `ssh2::Session`（libssh2，`Sync` 但 `!Send`，故只能留在单线程上）：

- `SessionManager`（`ssh-core/src/session.rs`）是公开 API，通过 `flume` channel 把 `SessionCmd` 发给 worker 线程；reply 也走 channel。
- `session_worker.rs` 是命令循环。交互 shell 永久 non-blocking；**SFTP 和隧道各在独立的 sub-worker 线程 + 独立重新认证的 SSH 连接**（`SessionFactory::establish_retry`），这样阻塞的传输/隧道操作永远不会卡住交互终端。SFTP 会话有 15s keepalive + 静默断线重连。
- ProxyJump 用本地 127.0.0.1 relay 线程把每个跳板串起来（`JumpHold` 保活，drop 时停）。
- **锁纪律**：`AppState` 里的 `Mutex`（尤其 `sessions`）绝不能在等待 reply channel 时被持有——先 clone sender 再阻塞。见 `commands/session.rs::session_cmd` 和 `SessionManager::sender`。

### Tauri 命令接线（新增命令的两步，缺一不可）

1. **后端**：在 `crates/app/src/commands/<模块>.rs` 写 `#[tauri::command]`，并在 `crates/app/src/lib.rs` 的 `tauri::generate_handler![...]` 注册。
2. **前端**：在 `src/lib/commands/index.ts` 用 `make<TResult, TArgs>("snake_case_name", validate?)` 登记类型化定义；调用方用 `cmd(commands.xxx, args)`。数组返回值建议配 `asArray()` 校验防协议漂移。

阻塞型命令模式（Windows 上避免卡 WebView/IPC 线程）：把实际工作丢到 `std::thread::spawn` + `flume::bounded(1)`，然后 `rx.recv_async().await`（见 `state.rs::run_blocking` 与 `commands/session.rs`）。错误统一走 `map_core_err` / `OrErr` trait。

### 事件流（worker → 前端）

session worker 把 `SessionEvent` 发到共享 flume sender → `crates/app/src/state.rs::install_event_bridge` 桥接为 Tauri 事件（终端输出 base64 编码）→ 前端 `src/lib/events/bus.ts`（`EventBus` 单例，懒初始化 Tauri listener）订阅。

- 终端输出有 HMR/StrictMode 安全缓冲（`src/lib/events.ts`）：`main.tsx` 渲染前先 `initEarlyTerminalBuffer()`，防止丢失早期 MOTD/提示符；重连时 `stashScrollback` 把旧滚动区搬到新 session。
- AI 流式输出走 `ai-chunk` / `ai-done` 事件，带 `requestId` 关联并发请求（见 `commands/ai.rs`）。SSE 在 Rust 端解析。
- `src/lib/tauri.ts` 是已废弃的兼容层，全部调用方已迁移到 `src/lib/commands`。

### 前端状态与视图

- Zustand store 在 `src/stores/`，每个 store 用 `globalThis` 上的 key（`__mshell_*_store_vN__`）做单例以**存活 Vite HMR**（改 store 形状要 bump 后缀）。`sessions.ts` 内含自动重连循环（指数退避，上限 30s）。
- 侧边栏是**特性注册表**插件系统：`src/features/registry.ts` 用 `registerFeature()` 登记视图（icon + panel），ActivityBar/SidePanel 自动渲染。
- 布局：`src/app/Shell.tsx`（会话标签 + 可选编辑器面板 ResizableSplitter + 终端 + 右侧 MonitorPane）。

### 持久化与凭据

- `store` crate：数据在 `dirs::data_dir()/mshell/` 下的 `connections.json`、`settings.json`、`known_hosts.json`。写入是原子写（同目录临时文件 + fsync + rename）；解析失败会备份 `.bak` 而不是覆盖。
- 凭据存在 Windows Credential Manager（keyring crate，`windows-native` feature）。连接 JSON 里只存 credential id（形如 `mshell/{连接UUID}/password`，keyring entry 还以 `SERVICE_NAME = "mshell"` 为命名空间；另有 `mshell/nil/ai_key`、`mshell/adhoc-{id}/password`），**从不存明文**；导出连接默认剥离凭据（即使 `include_secrets=true` 也只导出 credentialId 引用）。quick-connect（adhoc）的密码临时存 keyring，session 关闭时删除（`AppState::adhoc_creds`）。
- 主机密钥策略：SSH 用 `Strict`（未知/变更密钥抛 `hostKeyUnknown`/`hostKeyChanged`，前端弹窗确认后调 `host_key_trust`）；Telnet/Local/Serial 用 `StoreAndCompare`。

### 其他约定

- 根 `Cargo.toml` 用 `[patch.crates-io]` 指向 `.patched-libssh2-sys/`（为 Windows MSVC + OpenSSL 开启 EC/Ed25519 host key 支持），改动需谨慎。
- 系统托盘：关窗 = 最小化到托盘（`lib.rs` on_window_event），不是退出。
- 前端主题/高亮：`src/lib/themes/`，连接颜色/登录脚本等新字段记得在 protocol + types 两端同步并加 serde default。
- 提交信息用中文，不带 Co-Authored-By 尾注。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **mshell** (2141 symbols, 5125 relationships, 183 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/mshell/context` | Codebase overview, check index freshness |
| `gitnexus://repo/mshell/clusters` | All functional areas |
| `gitnexus://repo/mshell/processes` | All execution flows |
| `gitnexus://repo/mshell/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
