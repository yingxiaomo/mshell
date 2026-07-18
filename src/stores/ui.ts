import { create } from "zustand";
import type { SideViewId } from "../types/protocol";

type UiState = {
  activeView: SideViewId;
  setActiveView: (v: SideViewId) => void;
  sidebarWidth: number;
  setSidebarWidth: (w: number) => void;
};

export const useUiStore = create<UiState>((set) => ({
  activeView: "sessions",
  setActiveView: (activeView) => set({ activeView }),
  sidebarWidth: 260,
  setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
}));
