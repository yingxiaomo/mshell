import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  consumeTerminalOutput,
  replayTerminalHistory,
  encodeTerminalInput,
  feedHistoryToPending,
  takeCarryover,
} from "../../lib/events";
import { bus } from "../../lib/events/bus";
import { cmd, commands } from "../../lib/commands";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useTriggersStore } from "../../stores/triggers";
import { terminalThemeForChrome } from "../../lib/themes";
import { registerTerminalFind } from "../../lib/findHotkey";
import { showToast } from "../ui/Toast";

type CompiledTrigger = { re: RegExp; name: string; last: number };

type TerminalSlot = "full" | "left" | "right" | "hidden";

/** 解析十六进制字符串（支持空格分隔、0x 前缀）为字节数组。 */
function parseHexBytes(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, " ").replace(/[^0-9a-fA-F]/g, "");
  // 奇数位时丢弃末尾半字节（无法组成完整字节）
  const len = clean.length - (clean.length % 2);
  const bytes = new Uint8Array(len / 2);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

/** 字节数组 → base64（给 terminalWrite 用）。 */
function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

type TerminalViewProps = {
  sessionId: string;
  channelId: string;
  name?: string;
  fontFamily?: string;
  fontSize?: number;
  /** Serial port session → HEX 模式可用. */
  serialMode?: boolean;
  /** Primary pane: owns keyboard focus + the find hotkey. */
  active: boolean;
  /** Shown on screen → polls output, fits, observes resize. Defaults to `active`. */
  visible?: boolean;
  /** Layout position (split panes). Defaults from `active`. */
  slot?: TerminalSlot;
};

export const TerminalView = memo(function TerminalView({
  sessionId,
  channelId,
  fontFamily = "monospace",
  fontSize = 14,
  serialMode = false,
  active,
  visible = active,
  slot = active ? "full" : "hidden",
}: TerminalViewProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // HEX 模式：串口调试时以十六进制显示/输入字节
  const [hexMode, setHexMode] = useState(false);
  const hexModeRef = useRef(false);
  useEffect(() => { hexModeRef.current = hexMode; }, [hexMode]);
  const hexInputBufRef = useRef("");
  // Tracks `visible` for callbacks (ResizeObserver) whose effect isn't re-run on
  // visibility changes, so hidden terminals can be skipped without re-subscribing.
  const visibleRef = useRef(visible);
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  const appTheme = useSettingsStore((s) => s.settings.theme);
  const settingsFont = useSettingsStore((s) => s.settings.terminalFont);
  const settingsFontSize = useSettingsStore((s) => s.settings.terminalFontSize);
  const resolvedFont = fontFamily || settingsFont || "monospace";
  const resolvedSize = fontSize || settingsFontSize || 14;

  useEffect(() => {
    if (!active) { registerTerminalFind(null); return; }
    registerTerminalFind(() => {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    });
    return () => registerTerminalFind(null);
  }, [active]);

  useEffect(() => { if (!active) setSearchOpen(false); }, [active]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => {
      const el = searchInputRef.current;
      if (el) { el.focus(); if (el.value) el.select(); }
    });
  }, [searchOpen]);

  // ── Terminal session lifecycle ──────────────────────────────────────
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    const theme = terminalThemeForChrome(useSettingsStore.getState().settings.theme);
    const settings = useSettingsStore.getState().settings;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: resolvedFont,
      fontSize: resolvedSize,
      scrollback: Math.max(100, settings.terminalScrollback || 5000),
      theme,
      allowProposedApi: true,
      rightClickSelectsWord: false,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    searchAddonRef.current = searchAddon;
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;

    // Prevent wheel events from generating \x1b[A/\x1b[B escape sequences in
    // NORMAL screen mode (fixes ^[[B flood on scroll). In ALTERNATE screen
    // (vim/less/tmux), let xterm forward the wheel to the app (mouse reporting).
    const onWheel = (e: WheelEvent) => {
      const term = termRef.current;
      if (term && term.buffer.active.type === "alternate") return; // 放行给应用
      const viewport = el.querySelector('.xterm-viewport') as HTMLElement | null;
      if (viewport && e.deltaY !== 0) {
        viewport.scrollBy({ top: e.deltaY, behavior: 'auto' });
      }
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });

    const doFit = () => {
      try {
        if (el.clientWidth < 20 || el.clientHeight < 20) return;
        fit.fit();
        const cols = term.cols, rows = term.rows;
        if (cols > 0 && rows > 0) cmd(commands.terminalResize, { sessionId, channelId, cols, rows }).catch((e) => console.warn(e));
      } catch { console.warn("[term] fit failed"); }
    };
    doFit();
    // Fit again on the next frame (layout may not be settled yet), plus a
    // single deferred pass at 300ms in case of async layout shifts. The
    // ResizeObserver handles subsequent size changes efficiently via RAF +
    // dimension dedup, so multiple setTimeout attempts are redundant.
    const roFrame = requestAnimationFrame(() => doFit());
    const fitTimer = setTimeout(doFit, 300);

    // Replay scrollback carried over from a prior session (reconnect) so the
    // history survives the terminal being recreated with a new session id.
    const carry = takeCarryover(sessionId);
    if (carry.length) {
      for (const chunk of carry) term.write(chunk);
      term.write("\r\n\x1b[2m── 已重连 ──\x1b[0m\r\n");
    }
    feedHistoryToPending(sessionId);

    // ── AI 智能命令（/ai 前缀）：输入自然语言，AI 自动生成命令 ──
    let cmdBuf = "";
    // 仅当前标签自身发出 /ai 后才响应 ai-chunk/ai-done，且用 requestId 关联，
    // 避免多个标签页互相串扰、并发请求截断。用 Set 跟踪所有在途请求：并发
    // 多个 /ai 时，单个请求的 done 只清理自己，不会把后续请求一并作废。
    const activeAiRequests = new Set<string>();

    // 超时兜底：后端网络悬挂时（见 commands/ai.rs 无超时）也要清理在途请求，
    // 否则终端永远停留在"分析中…"。每个请求 120s 上限。
    const AI_TIMEOUT_MS = 120_000;

    // AI 回复流式写入终端
    const unsubChunk = bus.on("ai-chunk" as any, (payload: { requestId: string; text: string }) => {
      if (!activeAiRequests.has(payload.requestId)) return;
      const t = termRef.current;
      if (t) t.write(payload.text);
    });
    let pasteTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubDone = bus.on("ai-done" as any, (data: { requestId: string; text: string }) => {
      if (!activeAiRequests.has(data.requestId)) return;
      activeAiRequests.delete(data.requestId);
      const t = termRef.current;
      if (!t) return;
      const answer = data?.text || "";
      const clean = answer.replace(/```[\s\S]*?```/g, "").trim();
      if (clean && !clean.startsWith("无法完成")) {
        t.write("\r\n\x1b[32m💡 建议:\x1b[0m " + clean.split("\n")[0]!.trim() + "\r\n");
        if (pasteTimer) clearTimeout(pasteTimer);
        pasteTimer = setTimeout(() => {
          // 用 termRef 而非闭包捕获的终端，且确认终端仍存活再粘贴
          const live = termRef.current;
          try { live?.paste(clean); } catch { /* 终端已销毁 */ }
        }, 300);
      } else if (answer) {
        t.write("\r\n" + answer + "\r\n");
      }
    });

    const writeInput = (d: string) => {
      // HEX 模式：输入十六进制字节（如 "AA BB 0D 0A"），Enter 发送
      if (hexModeRef.current) {
        if (d === "\r") {
          const hexStr = hexInputBufRef.current;
          hexInputBufRef.current = "";
          const bytes = parseHexBytes(hexStr);
          term.write("\r\n");
          if (bytes.length > 0) {
            cmd(commands.terminalWrite, { sessionId, channelId, data: bytesToB64(bytes) }).catch((e) => console.warn(e));
            term.write(`\x1b[36m→ ${[...bytes].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}\x1b[0m\r\n`);
          }
          return;
        }
        if (d === "\x7f") {
          if (hexInputBufRef.current.length === 0) return;
          hexInputBufRef.current = hexInputBufRef.current.slice(0, -1);
          term.write("\x1b[D \x1b[D");
          return;
        }
        // 只接受单个十六进制字符/空格，忽略多字符控制序列（如 \x1b[D）
        if (d.length === 1 && /[0-9a-fA-F ]/.test(d)) {
          hexInputBufRef.current += d;
          term.write(d.toUpperCase());
        }
        return;
      }
      // 检测 /ai 指令提交
      if (d === "\r" && cmdBuf.startsWith("/ai")) {
        const prompt = cmdBuf.replace(/^\/ai\s*/, "").trim();
        cmdBuf = "";
        if (!prompt) return;
        term.write("\r\n");
        (async () => {
          try {
            const [key, ep] = await Promise.all([
              cmd(commands.aiGetKey).catch(() => ""),
              cmd(commands.aiGetEndpoint).catch(() => ""),
            ]);
            if (!key) { term.write("\x1b[33m⚠ AI 未配置，请先去 AI 面板设置 API Key\x1b[0m\r\n"); return; }
            term.write("\x1b[90m🤔 分析中...\x1b[0m\r\n");
            const requestId = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            activeAiRequests.add(requestId);
            const m = typeof localStorage !== "undefined" ? localStorage.getItem("mshell.ai-model") || "claude-sonnet-5-20250709" : "claude-sonnet-5-20250709";
            const ctx = replayTerminalHistory(sessionId).slice(-8).map((c) => new TextDecoder().decode(c)).join("");
            // 并发安全的请求级超时：仅清理自己，不影响其他在途 /ai。
            const timeoutId = setTimeout(() => {
              if (!activeAiRequests.has(requestId)) return;
              activeAiRequests.delete(requestId);
              term.write("\r\n\x1b[31m⚠ AI 请求超时（120s 无响应）\x1b[0m\r\n");
            }, AI_TIMEOUT_MS);
            try {
              await cmd(commands.aiChat, {
                messages: [
                  { role: "system", content: `你是 mshell 终端助手。\n最近终端输出:\n${ctx.slice(-3000)}\n用户用自然语言描述需求，请回复可执行的 shell 命令。只输出命令本身，不要解释。` },
                  { role: "user", content: prompt },
                ],
                apiKey: key, model: m, endpoint: ep || "", requestId,
              });
            } catch {
              if (activeAiRequests.has(requestId)) {
                activeAiRequests.delete(requestId);
                term.write("\x1b[31m⚠ AI 请求失败\x1b[0m\r\n");
              }
            } finally {
              clearTimeout(timeoutId);
            }
          } catch { term.write("\x1b[31m⚠ AI 请求失败\x1b[0m\r\n"); }
        })();
        return; // 不发送给 SSH
      }
      // 行缓冲追踪：只跟踪可打印字符；方向键等转义序列/控制键清空，
      // 避免「/ai」后按 ↑ 回滚命令误触发，也避免 IME/粘贴（多字符）漏跟踪
      if (d === "\r") cmdBuf = "";
      else if (d === "\x7f") cmdBuf = cmdBuf.slice(0, -1);
      else if (d.startsWith("\x1b") || d === "\x03" || d === "\x15" || d === "\x0b") cmdBuf = "";
      else cmdBuf += d;

      const enc = encodeTerminalInput(d);
      cmd(commands.terminalWrite, { sessionId, channelId, data: enc }).catch((e) => console.warn(e));
      for (const t of useSessionsStore.getState().getSyncedTargets(sessionId)) {
        cmd(commands.terminalWrite, { sessionId: t.sessionId, channelId: t.channelId, data: enc }).catch((e) => console.warn(e));
      }
    };

    const unsub = term.onData((d) => writeInput(d));
    const selDisp = term.onSelectionChange(() => {
      if (!useSettingsStore.getState().settings.copyOnSelect) return;
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel).catch((e) => console.warn(e));
    });

    const onKey = term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
        const sel = term.getSelection();
        if (sel) { void navigator.clipboard.writeText(sel).catch((e) => console.warn(e)); }
        return false;
      }
      if (mod && (e.key === "v" || e.key === "V") && !e.altKey) {
        void navigator.clipboard.readText().then((t) => { if (t) writeInput(t); }).catch((e) => console.warn(e));
        return false;
      }
      if (mod && !e.shiftKey && (e.key === "c" || e.key === "C")) {
        const sel = term.getSelection();
        if (sel) { void navigator.clipboard.writeText(sel).catch((e) => console.warn(e)); term.clearSelection(); return false; }
      }
      return true;
    });

    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      void navigator.clipboard.readText().then((t) => { if (t) writeInput(t); }).catch((e) => console.warn(e));
    };
    el.addEventListener("contextmenu", onContextMenu);

    const onAuxClick = (ev: MouseEvent) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      void navigator.clipboard.readText().then((t) => { if (t) writeInput(t); }).catch((e) => console.warn(e));
    };
    el.addEventListener("auxclick", onAuxClick);

    // Dedupe resize IPC: only notify the backend when cols/rows actually change,
    // so a fit storm can't flood terminal_resize.
    let lastCols = 0, lastRows = 0;
    const resizeUnsub = term.onResize(({ cols, rows }) => {
      if (cols > 0 && rows > 0 && (cols !== lastCols || rows !== lastRows)) {
        lastCols = cols; lastRows = rows;
        cmd(commands.terminalResize, { sessionId, channelId, cols, rows }).catch((e) => console.warn(e));
      }
    });
    doFit();
    if (active) term.focus();

    // Only refit the visible terminal. Gate on the container actually changing
    // size and defer to the next frame — otherwise fit() can re-trigger the
    // observer in a tight loop (WebView2 hangs hard on ResizeObserver loops),
    // which is what froze the app on split.
    let roScheduled = false;
    let lastW = -1, lastH = -1;
    const ro = new ResizeObserver((entries) => {
      if (!visibleRef.current) return;
      const cr = entries[0]?.contentRect;
      if (cr) {
        if (Math.round(cr.width) === lastW && Math.round(cr.height) === lastH) return;
        lastW = Math.round(cr.width); lastH = Math.round(cr.height);
      }
      if (roScheduled) return;
      roScheduled = true;
      requestAnimationFrame(() => {
        roScheduled = false;
        if (!visibleRef.current) return;
        try { fit.fit(); } catch { console.warn("[term] fit failed"); }
      });
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(roFrame);
      clearTimeout(fitTimer);
      ro.disconnect();
      el.removeEventListener("wheel", onWheel, { capture: true });
      unsub.dispose();
      unsubChunk();
      unsubDone();
      if (pasteTimer) clearTimeout(pasteTimer);
      selDisp.dispose();
      resizeUnsub.dispose();
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("auxclick", onAuxClick);
      void onKey;
      term.dispose();
      termRef.current = null; fitRef.current = null; searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, channelId]);

  // ── Live-update theme / font ──────────────────────────────────────
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalThemeForChrome(appTheme);
    term.options.fontFamily = resolvedFont;
    term.options.fontSize = resolvedSize;
  }, [appTheme, resolvedFont, resolvedSize]);


  // ── Async write with frame-budget pacing ────────────────────────
  const pendingWritesRef = useRef<Uint8Array[]>([]);
  const writeScheduledRef = useRef(false);

  function pumpWrites() {
    writeScheduledRef.current = false;
    const queue = pendingWritesRef.current;
    const chunk = queue.shift();
    if (!chunk) return;
    if (hexModeRef.current) {
      // HEX 显示：每字节转两位十六进制，空格分隔
      const hexStr = Array.from(chunk).map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
      termRef.current?.write(hexStr + " ");
    } else {
      termRef.current?.write(chunk);
    }
    if (queue.length > 0) { writeScheduledRef.current = true; requestAnimationFrame(pumpWrites); }
  }

  function enqueueWrite(chunks: Uint8Array[]) {
    for (const c of chunks) pendingWritesRef.current.push(c);
    if (!writeScheduledRef.current) { writeScheduledRef.current = true; requestAnimationFrame(pumpWrites); }
  }

  // ── Trigger scanning: alert (toast + bell) when a regex matches output ──
  const triggersRef = useRef<CompiledTrigger[]>([]);
  const scanTailRef = useRef("");
  const decoderRef = useRef<TextDecoder | null>(null);
  useEffect(() => {
    const compile = () => {
      triggersRef.current = useTriggersStore.getState().items
        .filter((t) => t.enabled)
        .map((t): CompiledTrigger | null => {
          try { return { re: new RegExp(t.pattern, "i"), name: t.name, last: 0 }; }
          catch { return null; }
        })
        .filter((x): x is CompiledTrigger => x != null);
    };
    compile();
    return useTriggersStore.subscribe(compile);
  }, []);

  function scanTriggers(chunks: Uint8Array[]) {
    const compiled = triggersRef.current;
    if (compiled.length === 0) return;
    if (!decoderRef.current) decoderRef.current = new TextDecoder("utf-8", { fatal: false });
    let text = "";
    for (const c of chunks) text += decoderRef.current.decode(c, { stream: true });
    if (!text) return;
    const combined = scanTailRef.current + text;
    const now = Date.now();
    for (const t of compiled) {
      if (t.re.test(combined) && now - t.last > 2000) {
        t.last = now;
        showToast(`⚡ 触发器命中：${t.name}`, "info");
        termRef.current?.write("\x07"); // terminal bell
      }
    }
    scanTailRef.current = combined.slice(-256); // carry for patterns split across chunks
  }

  // ── Refit when this tab becomes active (its ResizeObserver is gated off
  // while hidden, so it may have missed layout changes). onResize then emits
  // the terminalResize IPC automatically if dimensions changed. ──
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current;
    if (!fit) return;
    requestAnimationFrame(() => { try { fit.fit(); } catch { console.warn("[term] fit failed"); } });
  }, [visible]);

  // ── Poll effect: only runs when this tab is active so background
  // tabs don't flood the main thread during tab switching. ──
  useEffect(() => {
    if (!visible) return;
    const poll = setInterval(() => {
      const chunks = consumeTerminalOutput(sessionId);
      if (chunks.length === 0) return;
      scanTriggers(chunks);
      enqueueWrite(chunks);
    }, 80);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, channelId, visible]);
  const slotStyle: CSSProperties =
    slot === "hidden"
      ? { visibility: "hidden", pointerEvents: "none", position: "absolute", inset: 0, zIndex: 0 }
      : slot === "full"
        ? { position: "relative", zIndex: 1 }
        : {
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "50%",
            zIndex: 1,
            ...(slot === "left"
              ? { left: 0 }
              : { right: 0, borderLeft: "1px solid rgb(39 39 42)" }),
          };
  return (
    <div className="h-full w-full min-h-0 overflow-hidden px-2.5 py-1.5" data-terminal-root style={slotStyle}>
      <div ref={elRef}
        className="absolute inset-2.5 bottom-1.5 top-1.5 min-h-0 min-w-0 overflow-hidden [&_.xterm]:h-full [&_.xterm-viewport]:overflow-auto" />
      {serialMode && (
        <button
          type="button"
          onClick={() => { if (hexMode) hexInputBufRef.current = ""; setHexMode((v) => !v); }}
          title={hexMode ? "HEX 模式已开启：输入十六进制字节，Enter 发送" : "HEX 模式：以十六进制收发数据"}
          className={`absolute right-2 top-2 z-10 rounded px-1.5 py-0.5 text-[10px] font-medium ${
            hexMode ? "bg-sky-600 text-white" : "bg-zinc-800/80 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          HEX
        </button>
      )}
    </div>
  );
});
