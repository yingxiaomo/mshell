import type { ITerminalOptions } from "@xterm/xterm";

/** A color theme for the terminal (xterm) and editor (CodeMirror). */
export type EditorTerminalTheme = {
  /** Display label (e.g. "One Dark"). */
  label: string;
  /** Unique key (e.g. "one-dark"). Stored in AppSettings.theme. */
  key: string;
  /** Override for app chrome light/dark. If undefined, infer from background luminance. */
  chrome?: "dark" | "light";
  /** xterm theme colors (ITerminalOptions.theme). */
  terminal: ITerminalOptions["theme"];
};

/** All built-in themes. First entry = default. */
export const THEMES: EditorTerminalTheme[] = [
  {
    label: "One Dark",
    key: "one-dark",
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      selectionInactiveBackground: "#45475a",
    },
  },
  {
    label: "Catppuccin Mocha",
    key: "catppuccin-mocha",
    terminal: {
      background: "#11111b",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
    },
  },
  {
    label: "Dracula",
    key: "dracula",
    terminal: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
    },
  },
  {
    label: "Solarized Dark",
    key: "solarized-dark",
    terminal: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      selectionBackground: "#073642",
    },
  },
  {
    label: "Nord",
    key: "nord",
    terminal: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#88c0d0",
      selectionBackground: "#434c5e",
    },
  },
  {
    label: "Tokyo Night",
    key: "tokyo-night",
    terminal: {
      background: "#1a1b26",
      foreground: "#a9b1d6",
      cursor: "#c0caf5",
      selectionBackground: "#283457",
    },
  },
  {
    label: "Gruvbox Dark",
    key: "gruvbox-dark",
    terminal: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#fabd2f",
      selectionBackground: "#3c3836",
    },
  },
  {
    label: "Light (Default)",
    key: "light",
    chrome: "light",
    terminal: {
      background: "#ffffff",
      foreground: "#1e1e2e",
      cursor: "#1e1e2e",
      selectionBackground: "#d0d0d0",
    },
  },
];

export function themeByKey(key: string): EditorTerminalTheme {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]!;
}
