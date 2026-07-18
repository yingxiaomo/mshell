import { ActivityBar } from "../components/layout/ActivityBar";
import { SidePanel } from "../components/layout/SidePanel";
import { TitleBar } from "../components/layout/TitleBar";
import { TransferBar } from "../components/layout/TransferBar";
import { TerminalTabs } from "../components/terminal/TerminalTabs";

export function Shell() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <SidePanel />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-zinc-950">
          <TerminalTabs />
        </main>
      </div>
      <TransferBar />
    </div>
  );
}
