import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, RefreshCw, Send, Settings, Sparkles } from "lucide-react";
import { cmd, commands } from "../../lib/commands";
import { bus } from "../../lib/events/bus";
import { showToast } from "../ui/Toast";
import { useSessionsStore } from "../../stores/sessions";
import { replayTerminalHistory } from "../../lib/events";

type ChatMsg = { role: "user" | "assistant" | "system"; content: string };

export function AiChat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftEndpoint, setDraftEndpoint] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const ownStreamRef = useRef<string | null>(null);

  // 检查 Key 状态 + 加载配置
  useEffect(() => {
    const init = async () => {
      const k = await cmd(commands.aiHasKey).catch(() => false);
      setHasKey(k);
      if (k) {
        const ep = await cmd(commands.aiGetEndpoint).catch(() => "");
        setDraftEndpoint(ep);
        // 恢复上次选中的模型
        const saved = localStorage.getItem("mshell.ai-model");
        if (saved) setModel(saved);
        // 拉取模型列表
        try {
          const key = await cmd(commands.aiGetKey).catch(() => "");
          const list = await cmd(commands.aiListModels, { apiKey: key, endpoint: ep });
          setModels(list);
          if (list.length > 0 && !saved) setModel(list[0]!);
        } catch { /* 非致命，用户可手动刷新 */ }
      }
    };
    void init();
  }, []);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, streamText]);

  // Listen for streaming chunks
  useEffect(() => {
    // 仅消费面板自身发起的请求（通过 requestId 关联），避免终端 /ai 的回复乱入
    const unsubChunk = bus.on("ai-chunk" as any, (payload: { requestId: string; text: string }) => {
      if (ownStreamRef.current !== payload.requestId) return;
      setStreamText((prev) => prev + payload.text);
    });
    const unsubDone = bus.on("ai-done" as any, (data: { requestId: string; text: string }) => {
      if (ownStreamRef.current !== data.requestId) { ownStreamRef.current = null; return; }
      ownStreamRef.current = null;
      const full = data.text || "";
      setMessages((prev) => {
        return full
          ? [...prev, { role: "assistant", content: full }]
          : prev;
      });
      setStreamText("");
      setStreaming(false);
    });
    return () => { unsubChunk(); unsubDone(); };
  }, []);

  const getContext = useCallback(() => {
    const state = useSessionsStore.getState();
    const tab = state.tabs.find((t) => t.sessionId === state.activeSessionId);
    if (!tab) return "";
    const output = replayTerminalHistory(tab.sessionId);
    const recent = output.slice(-10).map((c) => new TextDecoder().decode(c)).join("");
    return `当前会话: ${tab.name}\n最近输出:\n${recent.slice(-3000)}`;
  }, []);

  const send = useCallback(async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || streaming) return;
    setInput("");
    const userMsg: ChatMsg = { role: "user", content: msg };
    setMessages((prev) => [...prev, userMsg]);
    const requestId = `panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    ownStreamRef.current = requestId;
    setStreaming(true);
    setStreamText("");

    const ctx = getContext();
    const systemMsg: ChatMsg = ctx
      ? { role: "system", content: `你是 mshell 终端助手。用户正在 SSH 会话中操作。\n${ctx}\n请给出简洁、可执行的命令建议。` }
      : { role: "system", content: "你是 mshell 终端助手。请用中文回答，给出简洁的命令建议。" };

    const key = await cmd(commands.aiGetKey).catch(() => "");
    const ep = await cmd(commands.aiGetEndpoint).catch(() => "");
    await cmd(commands.aiChat, {
      messages: [systemMsg, ...messages, userMsg],
      apiKey: key || "",
      model,
      endpoint: ep || "",
      requestId,
    }).catch((e) => {
      ownStreamRef.current = null;
      setStreamText("");
      setStreaming(false);
      showToast(e instanceof Error ? e.message : String(e), "error");
    });
  }, [input, streaming, messages, model, getContext]);

  const analyzeError = useCallback(async () => {
    const state = useSessionsStore.getState();
    const tab = state.tabs.find((t) => t.sessionId === state.activeSessionId);
    if (!tab) { showToast("没有活动会话", "info"); return; }
    const output = replayTerminalHistory(tab.sessionId);
    const recent = output.slice(-15).map((c) => new TextDecoder().decode(c)).join("");
    const prompt = `分析以下终端输出中的错误，给出解决方案：\n\`\`\`\n${recent.slice(-4000)}\n\`\`\``;
    await send(prompt);
  }, [send]);

  const copyToTerminal = useCallback((cmd: string) => {
    // Extract command from markdown code blocks
    const match = cmd.match(/```(?:\w+)?\n?([\s\S]*?)```/);
    const text = match ? match[1]!.trim() : cmd.trim();
    showToast(`建议已复制：${text.slice(0, 60)}`, "info");
    void navigator.clipboard.writeText(text);
  }, []);

  async function saveKey() {
    try {
      await cmd(commands.aiSaveKey, { key: draftKey.trim() });
      await cmd(commands.aiSaveEndpoint, { endpoint: draftEndpoint.trim() || "" });
      setHasKey(true);
      setSetupOpen(false);
      setDraftKey("");
      showToast("API 配置已保存", "success");
      // 保存后自动获取模型
      void fetchModels();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function fetchModels(endpoint?: string, key?: string) {
    setFetching(true);
    try {
      const ep = endpoint || draftEndpoint || (await cmd(commands.aiGetEndpoint).catch(() => ""));
      const k = key || draftKey || (await cmd(commands.aiGetKey).catch(() => ""));
      const list = await cmd(commands.aiListModels, { apiKey: k, endpoint: ep });
      setModels(list);
      if (list.length > 0 && !model) setModel(list[0]!);
      if (list.length > 0) showToast(`获取到 ${list.length} 个模型`, "success");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally { setFetching(false); }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const ep = draftEndpoint || (await cmd(commands.aiGetEndpoint).catch(() => ""));
      const k = draftKey || (await cmd(commands.aiGetKey).catch(() => ""));
      const result = await cmd(commands.aiTestConnection, { apiKey: k, endpoint: ep });
      setTestResult(result);
    } catch (e) {
      setTestResult(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally { setTesting(false); }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h1 className="flex items-center gap-1.5 text-sm font-semibold tracking-wide text-zinc-200">
          <Sparkles className="h-4 w-4 text-sky-400" /> AI
        </h1>
        <div className="flex items-center gap-1">
          <button type="button" onClick={analyzeError} disabled={streaming}
            className="rounded px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
            title="分析当前终端错误"
          >分析错误</button>
          <button type="button" onClick={() => setSetupOpen(true)}
            className={`rounded p-1 ${hasKey ? "text-zinc-500 hover:text-zinc-200" : "text-amber-400"}`}
            title={hasKey ? "API 密钥已配置" : "需要配置 API 密钥"}
          ><Settings className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !streaming && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <Bot className="h-10 w-10 text-zinc-700" />
            <p className="text-sm text-zinc-500">终端 AI 助手</p>
            <p className="text-xs text-zinc-600 max-w-xs">
              点「分析错误」自动发送最近输出，或直接输入问题。
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              m.role === "user" ? "bg-sky-600/20 text-zinc-100" : "bg-zinc-800/60 text-zinc-200"
            }`}>
              <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed">{m.content}</pre>
              {m.role === "assistant" && (
                <button type="button" onClick={() => copyToTerminal(m.content)}
                  className="mt-1 rounded px-1.5 py-0.5 text-[10px] text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                >复制命令</button>
              )}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg bg-zinc-800/60 px-3 py-2 text-sm text-zinc-200">
              {streamText ? (
                <pre className="whitespace-pre-wrap font-sans text-[13px]">{streamText}</pre>
              ) : (
                <div className="flex items-center gap-1.5 py-0.5">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" />
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" style={{ animationDelay: "0.2s" }} />
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" style={{ animationDelay: "0.4s" }} />
                  <span className="ml-1 text-xs text-zinc-500">思考中…</span>
                </div>
              )}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 模型选择 + 输入 */}
      <div className="border-t border-zinc-800 px-3 py-2 space-y-2">
        {hasKey && (
          <div className="flex items-center gap-1.5">
            <select value={model} onChange={(e) => { setModel(e.target.value); localStorage.setItem("mshell.ai-model", e.target.value); }}
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400 outline-none"
            >
              {models.length === 0 && <option value="">加载模型列表…</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button type="button" disabled={fetching} onClick={() => void fetchModels()}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 disabled:opacity-30"
              title="刷新模型列表"
            ><RefreshCw className={`h-3 w-3 ${fetching ? "animate-spin" : ""}`} /></button>
          </div>
        )}
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={hasKey ? "输入问题…" : "先配置 API Key"}
            disabled={!hasKey || streaming}
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <button type="button" disabled={!input.trim() || !hasKey || streaming}
            onClick={() => void send()}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
          ><Send className="h-3.5 w-3.5" /></button>
        </div>
      </div>

      {/* API 配置弹窗 */}
      {setupOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4" role="presentation"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setSetupOpen(false); }}>
          <div role="dialog" className="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-base font-semibold text-zinc-100">AI API 配置</h2>
            <p className="mb-4 text-xs text-zinc-500">支持 Anthropic Claude、OpenAI 和兼容 API。</p>

            <label className="mb-1 block text-[11px] font-medium text-zinc-400">API Key</label>
            <input type="password" value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder="sk-ant-… 或 sk-…"
              className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-600"
            />

            <label className="mb-1 block text-[11px] font-medium text-zinc-400">自定义端点（可选）</label>
            <input value={draftEndpoint}
              onChange={(e) => setDraftEndpoint(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); if (e.key === "Escape") setSetupOpen(false); }}
              placeholder="留空使用默认 API → http://localhost:11434/v1"
              className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-600"
            />
            <p className="mb-4 text-[11px] text-zinc-600">
              Key 和端点通过系统 keyring 加密存储。<br />
              留空端点使用默认 Claude/OpenAI。<br />
              设置后走 OpenAI 兼容协议（支持 Ollama / vLLM / LocalAI 等）。
            </p>

            <button type="button" disabled={testing} onClick={testConnection}
              className="mb-2 w-full rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >{testing ? "测试中…" : "测试连接"}</button>
            {testResult && (
              <p className={`mb-2 text-xs ${testResult.startsWith("✅") ? "text-emerald-400" : "text-red-400"}`}>{testResult}</p>
            )}

            <div className="flex justify-between">
              {hasKey && (
                <button type="button" className="text-xs text-zinc-500 hover:text-red-400"
                  onClick={async () => {
                    await cmd(commands.aiSaveKey, { key: "" }).catch(() => {});
                    await cmd(commands.aiSaveEndpoint, { endpoint: "" }).catch(() => {});
                    setHasKey(false);
                    setDraftEndpoint("");
                    setSetupOpen(false);
                    showToast("API 配置已清除", "info");
                  }}
                >清除配置</button>
              )}
              <div className="flex gap-2 ml-auto">
                <button type="button" onClick={() => setSetupOpen(false)}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">取消</button>
                <button type="button" onClick={() => void saveKey()}
                  className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500">保存</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
