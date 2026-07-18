import { ActivityBar } from "../components/layout/ActivityBar";
import { SidePanel } from "../components/layout/SidePanel";
import { TitleBar } from "../components/layout/TitleBar";

export function Shell() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <SidePanel />
        <main className="flex min-w-0 flex-1 flex-col bg-zinc-950">
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-sm text-zinc-600">
              终端区域 — 连接会话后在此显示
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
