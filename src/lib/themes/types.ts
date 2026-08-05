import type { ITerminalOptions } from "@xterm/xterm";

/** Syntax token colors — like VS Code / JetBrains theme scopes. */
export type SyntaxPalette = {
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  type: string;
  className: string;
  property: string;
  variable: string;
  operator: string;
  constant: string;
  tag: string;
  attribute: string;
  meta: string;
  invalid: string;
  punctuation: string;
};

/** A color theme for the terminal (xterm) and editor (CodeMirror). */
export type EditorTerminalTheme = {
  /** Display label (e.g. "One Dark"). */
  label: string;
  /** Unique key (e.g. "one-dark"). Stored in AppSettings.codeTheme. */
  key: string;
  /** Override for app chrome light/dark. If undefined, treat as dark. */
  chrome?: "dark" | "light";
  /** xterm theme colors (ITerminalOptions.theme) — legacy / reference only. */
  terminal: NonNullable<ITerminalOptions["theme"]>;
  /** Syntax colors for dark app chrome (dark editor surface). */
  syntax: SyntaxPalette;
  /**
   * Syntax colors for light app chrome (white editor surface).
   * If omitted, a high-contrast light fallback is used.
   */
  syntaxLight?: SyntaxPalette;
};