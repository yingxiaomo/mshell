/**
 * 事件总线 — 类型安全的事件发布/订阅
 *
 * 用法:
 *   import { bus } from "../lib/events/bus";
 *   // 监听
 *   const unsub = bus.on("terminal-output", (payload) => { ... });
 *   // 组件卸载时取消
 *   useEffect(() => bus.on("session-disconnected", fn), []);
 *
 * 旧 events.ts 保持不变作为底层实现；新代码通过 bus 访问。
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EventName,
  type TerminalOutputEvent,
  type TransferProgressEvent,
  type TunnelStatus,
} from "../../types/protocol";
import type { SessionDisconnectedEvent } from "../events";

// ── 事件负载类型映射 ──────────────────────────────────────────

export interface EventMap {
  [EventName.TERMINAL_OUTPUT]:      TerminalOutputEvent;
  [EventName.SESSION_DISCONNECTED]: SessionDisconnectedEvent;
  [EventName.TRANSFER_PROGRESS]:    TransferProgressEvent;
  [EventName.TUNNEL_STATUS]:        TunnelStatus;
  "ai-chunk":                       string;
  "ai-done":                        { text: string };
}

export type EventName_ = keyof EventMap;
export type EventHandler<E extends EventName_> = (payload: EventMap[E]) => void;

// ── 事件总线实现 ──────────────────────────────────────────────

type ListenerRecord = {
  tauriUnlisten: UnlistenFn | null;  // null = 尚未初始化 Tauri listener
  handlers: Set<Function>;
  disposed: boolean;                 // true = 已在初始化完成前被取消订阅
};

class EventBus {
  private listeners = new Map<string, ListenerRecord>();
  private initPromises = new Map<string, Promise<void>>();

  /** 注册事件处理器。返回取消函数。 */
  on<E extends EventName_>(
    event: E,
    handler: EventHandler<E>,
  ): () => void {
    let record = this.listeners.get(event);
    if (!record) {
      record = { tauriUnlisten: null, handlers: new Set(), disposed: false };
      this.listeners.set(event, record);
      this.initTauriListener(event, record);
    }
    record.handlers.add(handler as Function);

    return () => {
      const r = this.listeners.get(event);
      if (!r) return;
      r.handlers.delete(handler as Function);
      if (r.handlers.size === 0) {
        // Mark disposed so an in-flight initTauriListener tears itself down
        // once it resolves, and drop BOTH the record and the init promise so a
        // later on() re-binds a fresh native listener (else this event goes
        // permanently deaf after its last subscriber unmounts).
        r.disposed = true;
        if (r.tauriUnlisten) {
          r.tauriUnlisten();
        }
        this.listeners.delete(event);
        this.initPromises.delete(event);
      }
    };
  }

  /** 一次性监听 */
  once<E extends EventName_>(event: E, handler: EventHandler<E>): void {
    const unsub = this.on(event, ((payload: EventMap[E]) => {
      unsub();
      handler(payload);
    }) as EventHandler<E>);
  }

  /** 等待事件触发一次（Promise 风格） */
  waitFor<E extends EventName_>(event: E, timeout?: number): Promise<EventMap[E]> {
    return new Promise((resolve, reject) => {
      const unsub = this.on(event, (payload) => {
        unsub();
        resolve(payload);
      });
      if (timeout && timeout > 0) {
        setTimeout(() => {
          unsub();
          reject(new Error(`waitFor('${event}') timed out after ${timeout}ms`));
        }, timeout);
      }
    });
  }

  /** 初始化 Tauri 原生事件监听（惰性，仅在首次 on 时调用） */
  private initTauriListener(event: string, record: ListenerRecord) {
    if (this.initPromises.has(event)) return;
    const p = (async () => {
      try {
        const unlisten = await listen<any>(event, (e) => {
          record.handlers.forEach((fn) => fn(e.payload));
        });
        if (record.disposed) {
          // Unsubscribed before init resolved — tear down immediately so we
          // don't leak the native listener.
          unlisten();
        } else {
          record.tauriUnlisten = unlisten;
        }
      } catch {
        // Tauri 事件系统尚未就绪（如浏览器热重载）
      }
    })();
    this.initPromises.set(event, p);
  }
}

/** 全局单例 */
export const bus = new EventBus();
