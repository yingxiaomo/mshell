/**
 * useCommand — 统一的异步命令调用 hook
 *
 * 消除 loading/error 样板代码。
 *
 * 用法:
 *   const { execute: doSave, loading } = useCommand(commands.saveConnection);
 *   await doSave({ conn, password: "xxx" });
 */

import { useState, useCallback } from "react";
import { cmd, type CommandDef } from "../commands";

export function useCommand<TResult, TArgs extends Record<string, unknown> = Record<string, unknown>>(
  def: CommandDef<TResult, TArgs>,
) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(
    async (args?: TArgs): Promise<TResult | undefined> => {
      setLoading(true);
      setError(null);
      try {
        const result = await cmd(def, args);
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [def],
  );

  const clearError = useCallback(() => setError(null), []);

  return { execute, loading, error, clearError };
}
