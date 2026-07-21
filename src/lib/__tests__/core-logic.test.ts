/// <reference types="vitest/globals" />

import { describe, expect, it } from "vitest";

// Pure helpers that don't need Tauri at import time.
import { editorTabId, type EditorTab } from "../../stores/ui";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type Connection,
  type ConnectionProtocol,
} from "../../types/protocol";

// --- mirror of normalizeSettings logic used by settings store (kept pure for tests) ---
function isPaletteKey(key: string): boolean {
  return [
    "one-dark",
    "catppuccin-mocha",
    "dracula",
    "solarized-dark",
    "nord",
    "tokyo-night",
    "gruvbox-dark",
    "light",
  ].includes(key);
}

function chromeMode(key: string): "dark" | "light" {
  if (key === "light") return "light";
  if (key === "dark") return "dark";
  return isPaletteKey(key) && key === "light" ? "light" : "dark";
}

function normalizeSettings(raw: AppSettings): AppSettings {
  const next: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    ...raw,
    codeTheme: raw.codeTheme || DEFAULT_APP_SETTINGS.codeTheme,
  };
  if (next.theme !== "dark" && next.theme !== "light") {
    if (isPaletteKey(next.theme)) {
      if (!raw.codeTheme || raw.codeTheme === DEFAULT_APP_SETTINGS.codeTheme) {
        next.codeTheme = next.theme;
      }
    }
    next.theme = chromeMode(next.theme);
  }
  if (!isPaletteKey(next.codeTheme)) {
    next.codeTheme = DEFAULT_APP_SETTINGS.codeTheme;
  }
  return next;
}

// --- session-scoped editor tab filtering (Shell / EditorTabs logic) ---
function editorTabsForSession(
  tabs: EditorTab[],
  sessionId: string | null,
): EditorTab[] {
  if (!sessionId) return [];
  return tabs.filter((t) => t.sessionId === sessionId);
}

function closeEditorTabsForSession(
  tabs: EditorTab[],
  sessionId: string,
  activeId: string | null,
): { tabs: EditorTab[]; activeId: string | null } {
  const remaining = tabs.filter((t) => t.sessionId !== sessionId);
  let active = activeId;
  if (active && tabs.some((t) => t.id === active && t.sessionId === sessionId)) {
    active =
      remaining.length > 0 ? remaining[remaining.length - 1]!.id : null;
  }
  return { tabs: remaining, activeId: active };
}

function protocolLabel(p?: ConnectionProtocol): string {
  switch (p) {
    case "telnet":
      return "Telnet";
    case "local":
      return "本地";
    case "serial":
      return "串口";
    default:
      return "SSH";
  }
}

describe("editorTabId", () => {
  it("joins session and path", () => {
    expect(editorTabId("s1", "/etc/hosts")).toBe("s1::/etc/hosts");
  });
});

describe("normalizeSettings", () => {
  it("keeps dark|light chrome", () => {
    const s = normalizeSettings({
      ...DEFAULT_APP_SETTINGS,
      theme: "light",
      codeTheme: "dracula",
    });
    expect(s.theme).toBe("light");
    expect(s.codeTheme).toBe("dracula");
  });

  it("migrates legacy palette theme into codeTheme", () => {
    const s = normalizeSettings({
      ...DEFAULT_APP_SETTINGS,
      theme: "nord",
      codeTheme: DEFAULT_APP_SETTINGS.codeTheme,
    });
    expect(s.theme).toBe("dark");
    expect(s.codeTheme).toBe("nord");
  });

  it("falls back invalid codeTheme", () => {
    const s = normalizeSettings({
      ...DEFAULT_APP_SETTINGS,
      codeTheme: "not-a-real-theme",
    });
    expect(s.codeTheme).toBe(DEFAULT_APP_SETTINGS.codeTheme);
  });
});

describe("editor tabs per session", () => {
  const tabs: EditorTab[] = [
    {
      id: editorTabId("a", "/a.sh"),
      sessionId: "a",
      remotePath: "/a.sh",
      name: "a.sh",
    },
    {
      id: editorTabId("b", "/b.sh"),
      sessionId: "b",
      remotePath: "/b.sh",
      name: "b.sh",
    },
    {
      id: editorTabId("a", "/c.sh"),
      sessionId: "a",
      remotePath: "/c.sh",
      name: "c.sh",
    },
  ];

  it("filters tabs for active session only", () => {
    expect(editorTabsForSession(tabs, "a").map((t) => t.name)).toEqual([
      "a.sh",
      "c.sh",
    ]);
    expect(editorTabsForSession(tabs, "b")).toHaveLength(1);
    expect(editorTabsForSession(tabs, null)).toEqual([]);
  });

  it("closes only one session's editors and rebinds active", () => {
    const active = editorTabId("a", "/a.sh");
    const r = closeEditorTabsForSession(tabs, "a", active);
    expect(r.tabs.map((t) => t.sessionId)).toEqual(["b"]);
    expect(r.activeId).toBe(editorTabId("b", "/b.sh"));
  });

  it("keeps active if it belongs to another session", () => {
    const active = editorTabId("b", "/b.sh");
    const r = closeEditorTabsForSession(tabs, "a", active);
    expect(r.activeId).toBe(active);
    expect(r.tabs).toHaveLength(1);
  });
});

describe("protocol labels", () => {
  it("maps known protocols", () => {
    expect(protocolLabel("ssh")).toBe("SSH");
    expect(protocolLabel("telnet")).toBe("Telnet");
    expect(protocolLabel("local")).toBe("本地");
    expect(protocolLabel("serial")).toBe("串口");
    expect(protocolLabel(undefined)).toBe("SSH");
  });
});

describe("connection protocol defaults", () => {
  it("treats missing protocol as SSH for display", () => {
    const c = {
      id: "x",
      name: "n",
      host: "h",
      port: 22,
      username: "u",
      auth: { type: "agent" as const },
      tags: [],
      tunnels: [],
      source: { type: "manual" as const },
      protocol: "ssh",
      group: null,
      jumpHost: null,
      lastConnected: null,
      notes: null,
    } satisfies Connection;
    expect(protocolLabel(c.protocol)).toBe("SSH");
  });
});
