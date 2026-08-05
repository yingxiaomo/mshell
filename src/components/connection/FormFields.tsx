import React from "react";

export const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500";

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-xs text-zinc-400">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}
