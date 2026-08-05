/**
 * 表单 DSL — 消除大量重复的 useState/onChange 样板代码
 *
 * 用法:
 *   const form = useForm({ name: "", host: "", port: 22 });
 *   <input {...form.field("name")} />
 *   <input type="number" {...form.numberField("port")} />
 *   <input type="checkbox" {...form.boolField("remember")} />
 *   <select {...form.field("protocol")}>...
 *   form.setField("authType", "password");
 */

import { useState, useCallback, useRef } from "react";

// ── Hook ───────────────────────────────────────────────────────

export function useForm<T extends Record<string, any>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const initialRef = useRef(initial);

  /** 批量更新字段 */
  const set = useCallback((patch: Partial<T>) => {
    setValues((prev) => ({ ...prev, ...patch }));
  }, []);

  /** 重置为初始值 */
  const reset = useCallback(() => {
    setValues({ ...initialRef.current });
  }, []);

  /** 更新单个字段 */
  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  /** 文本/选择字段绑定: <input {...field("name")} /> */
  const field = useCallback(
    <K extends keyof T>(key: K) => ({
      value: values[key] as unknown as string,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setValues((prev) => ({ ...prev, [key]: e.target.value as T[K] }));
      },
    }),
    [values],
  );

  /** 数字字段: <input type="number" {...numberField("port")} /> */
  const numberField = useCallback(
    (key: keyof T) => ({
      value: values[key] as unknown as number,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setValues((prev) => ({ ...prev, [key]: Number(e.target.value) as T[keyof T] }));
      },
    }),
    [values],
  );

  /** 布尔字段: <input type="checkbox" {...boolField("autoStart")} /> */
  const boolField = useCallback(
    (key: keyof T) => ({
      checked: values[key] as unknown as boolean,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setValues((prev) => ({ ...prev, [key]: e.target.checked as T[keyof T] }));
      },
    }),
    [values],
  );

  /** 选项字段: <select {...selectField("protocol", options)} /> */
  const selectField = useCallback(
    <K extends keyof T>(key: K) => ({
      value: values[key] as unknown as string,
      onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
        setValues((prev) => ({ ...prev, [key]: e.target.value as T[K] }));
      },
    }),
    [values],
  );

  return { values, set, reset, setField, field, numberField, boolField, selectField };
}
