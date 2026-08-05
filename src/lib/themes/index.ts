import { EditorView } from "@codemirror/view";
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { ITerminalOptions } from "@xterm/xterm";
import type { SyntaxPalette, EditorTerminalTheme } from "./types";
export type { SyntaxPalette, EditorTerminalTheme } from "./types";
export { languageFromShebang, languageExtensionForPath } from "./languages";

/** Shared tag → color mapping for every palette. */
function highlightStyleFrom(s: SyntaxPalette): HighlightStyle {
  return HighlightStyle.define([
    { tag: t.keyword, color: s.keyword },
    { tag: t.controlKeyword, color: s.keyword },
    { tag: t.moduleKeyword, color: s.keyword },
    { tag: t.operatorKeyword, color: s.keyword },
    { tag: t.definitionKeyword, color: s.keyword },
    { tag: t.modifier, color: s.keyword },
    { tag: t.self, color: s.keyword },

    { tag: t.comment, color: s.comment, fontStyle: "italic" },
    { tag: t.lineComment, color: s.comment, fontStyle: "italic" },
    { tag: t.blockComment, color: s.comment, fontStyle: "italic" },
    { tag: t.docComment, color: s.comment, fontStyle: "italic" },

    { tag: t.string, color: s.string },
    { tag: t.special(t.string), color: s.string },
    { tag: t.character, color: s.string },
    { tag: t.docString, color: s.string },
    { tag: t.regexp, color: s.string },
    { tag: t.escape, color: s.string },

    { tag: t.number, color: s.number },
    { tag: t.integer, color: s.number },
    { tag: t.float, color: s.number },
    { tag: t.bool, color: s.constant },
    { tag: t.null, color: s.constant },
    { tag: t.atom, color: s.constant },
    { tag: t.constant(t.name), color: s.constant },
    { tag: t.standard(t.name), color: s.constant },

    { tag: t.function(t.variableName), color: s.function },
    { tag: t.function(t.propertyName), color: s.function },
    { tag: t.definition(t.function(t.variableName)), color: s.function },
    { tag: t.labelName, color: s.function },

    { tag: t.typeName, color: s.type },
    { tag: t.namespace, color: s.type },
    { tag: t.className, color: s.className },
    { tag: t.definition(t.className), color: s.className },

    { tag: t.propertyName, color: s.property },
    { tag: t.definition(t.propertyName), color: s.property },
    { tag: t.attributeName, color: s.attribute },
    { tag: t.attributeValue, color: s.string },

    { tag: t.variableName, color: s.variable },
    { tag: t.definition(t.variableName), color: s.variable },
    { tag: t.special(t.variableName), color: s.constant },

    { tag: t.operator, color: s.operator },
    { tag: t.punctuation, color: s.punctuation },
    { tag: t.separator, color: s.punctuation },
    { tag: t.bracket, color: s.punctuation },
    { tag: t.angleBracket, color: s.punctuation },
    { tag: t.squareBracket, color: s.punctuation },
    { tag: t.paren, color: s.punctuation },
    { tag: t.brace, color: s.punctuation },

    { tag: t.tagName, color: s.tag },
    { tag: t.angleBracket, color: s.punctuation },
    { tag: t.meta, color: s.meta },
    { tag: t.processingInstruction, color: s.meta },
    { tag: t.macroName, color: s.meta },
    { tag: t.annotation, color: s.meta },

    { tag: t.link, color: s.string, textDecoration: "underline" },
    { tag: t.url, color: s.string, textDecoration: "underline" },
    { tag: t.heading, color: s.keyword, fontWeight: "bold" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.invalid, color: s.invalid },
  ]);
}

/** All built-in code palettes. First entry = default. */
export const THEMES: EditorTerminalTheme[] = [
  {
    label: "One Dark",
    key: "one-dark",
    terminal: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      selectionBackground: "#3e4451",
      selectionInactiveBackground: "#2c313a",
    },
    // One Dark (dark surface)
    syntax: {
      keyword: "#c678dd",
      string: "#98c379",
      comment: "#5c6370",
      number: "#d19a66",
      function: "#61afef",
      type: "#e5c07b",
      className: "#e5c07b",
      property: "#e06c75",
      variable: "#e06c75",
      operator: "#56b6c2",
      constant: "#d19a66",
      tag: "#e06c75",
      attribute: "#d19a66",
      meta: "#61afef",
      invalid: "#ffffff",
      punctuation: "#abb2bf",
    },
    // One Light — readable on white
    syntaxLight: {
      keyword: "#a626a4",
      string: "#50a14f",
      comment: "#a0a1a7",
      number: "#986801",
      function: "#4078f2",
      type: "#c18401",
      className: "#c18401",
      property: "#e45649",
      variable: "#e45649",
      operator: "#0184bc",
      constant: "#986801",
      tag: "#e45649",
      attribute: "#986801",
      meta: "#4078f2",
      invalid: "#ff0000",
      punctuation: "#383a42",
    },
  },
  {
    label: "Catppuccin Mocha",
    key: "catppuccin-mocha",
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
    },
    syntax: {
      keyword: "#cba6f7",
      string: "#a6e3a1",
      comment: "#6c7086",
      number: "#fab387",
      function: "#89b4fa",
      type: "#f9e2af",
      className: "#f9e2af",
      property: "#b4befe",
      variable: "#cdd6f4",
      operator: "#89dceb",
      constant: "#fab387",
      tag: "#f38ba8",
      attribute: "#f9e2af",
      meta: "#89b4fa",
      invalid: "#f38ba8",
      punctuation: "#9399b2",
    },
    // Catppuccin Latte
    syntaxLight: {
      keyword: "#8839ef",
      string: "#40a02b",
      comment: "#9ca0b0",
      number: "#fe640b",
      function: "#1e66f5",
      type: "#df8e1d",
      className: "#df8e1d",
      property: "#7287fd",
      variable: "#4c4f69",
      operator: "#04a5e5",
      constant: "#fe640b",
      tag: "#d20f39",
      attribute: "#df8e1d",
      meta: "#1e66f5",
      invalid: "#d20f39",
      punctuation: "#6c6f85",
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
    syntax: {
      keyword: "#ff79c6",
      string: "#f1fa8c",
      comment: "#6272a4",
      number: "#bd93f9",
      function: "#50fa7b",
      type: "#8be9fd",
      className: "#8be9fd",
      property: "#66d9ef",
      variable: "#f8f8f2",
      operator: "#ff79c6",
      constant: "#bd93f9",
      tag: "#ff79c6",
      attribute: "#50fa7b",
      meta: "#f8f8f2",
      invalid: "#ff5555",
      punctuation: "#f8f8f2",
    },
    // Dracula-inspired light (deeper hues on white)
    syntaxLight: {
      keyword: "#c41a7a",
      string: "#8a7000",
      comment: "#6b6f94",
      number: "#6b4fbb",
      function: "#1f8a3a",
      type: "#0e7c8a",
      className: "#0e7c8a",
      property: "#0b6e8a",
      variable: "#1e1f29",
      operator: "#c41a7a",
      constant: "#6b4fbb",
      tag: "#c41a7a",
      attribute: "#1f8a3a",
      meta: "#44475a",
      invalid: "#cc0000",
      punctuation: "#44475a",
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
    syntax: {
      keyword: "#859900",
      string: "#2aa198",
      comment: "#586e75",
      number: "#d33682",
      function: "#268bd2",
      type: "#b58900",
      className: "#b58900",
      property: "#268bd2",
      variable: "#839496",
      operator: "#859900",
      constant: "#cb4b16",
      tag: "#268bd2",
      attribute: "#93a1a1",
      meta: "#859900",
      invalid: "#dc322f",
      punctuation: "#839496",
    },
    // Solarized Light
    syntaxLight: {
      keyword: "#859900",
      string: "#2aa198",
      comment: "#93a1a1",
      number: "#d33682",
      function: "#268bd2",
      type: "#b58900",
      className: "#b58900",
      property: "#268bd2",
      variable: "#657b83",
      operator: "#859900",
      constant: "#cb4b16",
      tag: "#268bd2",
      attribute: "#657b83",
      meta: "#859900",
      invalid: "#dc322f",
      punctuation: "#586e75",
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
    syntax: {
      keyword: "#81a1c1",
      string: "#a3be8c",
      comment: "#616e88",
      number: "#b48ead",
      function: "#88c0d0",
      type: "#8fbcbb",
      className: "#8fbcbb",
      property: "#d8dee9",
      variable: "#d8dee9",
      operator: "#81a1c1",
      constant: "#b48ead",
      tag: "#81a1c1",
      attribute: "#8fbcbb",
      meta: "#5e81ac",
      invalid: "#bf616a",
      punctuation: "#eceff4",
    },
    // Nord-ish light (polar night accents on snow)
    syntaxLight: {
      keyword: "#5e81ac",
      string: "#4d7c0f",
      comment: "#7b88a1",
      number: "#8f3f71",
      function: "#0f6e82",
      type: "#0b6e6a",
      className: "#0b6e6a",
      property: "#2e3440",
      variable: "#2e3440",
      operator: "#5e81ac",
      constant: "#8f3f71",
      tag: "#5e81ac",
      attribute: "#0b6e6a",
      meta: "#4c566a",
      invalid: "#bf616a",
      punctuation: "#4c566a",
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
    syntax: {
      keyword: "#bb9af7",
      string: "#9ece6a",
      comment: "#565f89",
      number: "#ff9e64",
      function: "#7aa2f7",
      type: "#2ac3de",
      className: "#2ac3de",
      property: "#7dcfff",
      variable: "#c0caf5",
      operator: "#89ddff",
      constant: "#ff9e64",
      tag: "#f7768e",
      attribute: "#9ece6a",
      meta: "#7aa2f7",
      invalid: "#db4b4b",
      punctuation: "#a9b1d6",
    },
    // Tokyo Night Day-inspired
    syntaxLight: {
      keyword: "#5a4a78",
      string: "#33635c",
      comment: "#848cb5",
      number: "#965027",
      function: "#34548a",
      type: "#0f4b6e",
      className: "#0f4b6e",
      property: "#0f4b6e",
      variable: "#343b58",
      operator: "#006a83",
      constant: "#965027",
      tag: "#8c4351",
      attribute: "#33635c",
      meta: "#34548a",
      invalid: "#8c4351",
      punctuation: "#565a6e",
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
    syntax: {
      keyword: "#fb4934",
      string: "#b8bb26",
      comment: "#928374",
      number: "#d3869b",
      function: "#b8bb26",
      type: "#fabd2f",
      className: "#fabd2f",
      property: "#83a598",
      variable: "#ebdbb2",
      operator: "#fe8019",
      constant: "#d3869b",
      tag: "#fb4934",
      attribute: "#fabd2f",
      meta: "#8ec07c",
      invalid: "#fb4934",
      punctuation: "#ebdbb2",
    },
    // Gruvbox Light
    syntaxLight: {
      keyword: "#9d0006",
      string: "#79740e",
      comment: "#928374",
      number: "#8f3f71",
      function: "#79740e",
      type: "#b57614",
      className: "#b57614",
      property: "#076678",
      variable: "#3c3836",
      operator: "#af3a03",
      constant: "#8f3f71",
      tag: "#9d0006",
      attribute: "#b57614",
      meta: "#427b58",
      invalid: "#9d0006",
      punctuation: "#504945",
    },
  },
  {
    label: "GitHub Light",
    key: "light",
    chrome: "light",
    terminal: {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#24292f",
      selectionBackground: "#add6ff",
    },
    syntax: {
      keyword: "#cf222e",
      string: "#0a3069",
      comment: "#6e7781",
      number: "#0550ae",
      function: "#8250df",
      type: "#953800",
      className: "#953800",
      property: "#0550ae",
      variable: "#24292f",
      operator: "#cf222e",
      constant: "#0550ae",
      tag: "#116329",
      attribute: "#0550ae",
      meta: "#1f2328",
      invalid: "#82071e",
      punctuation: "#24292f",
    },
    // Same palette works on light; dark chrome gets a dimmer twin if user keeps this key
    syntaxLight: {
      keyword: "#cf222e",
      string: "#0a3069",
      comment: "#6e7781",
      number: "#0550ae",
      function: "#8250df",
      type: "#953800",
      className: "#953800",
      property: "#0550ae",
      variable: "#24292f",
      operator: "#cf222e",
      constant: "#0550ae",
      tag: "#116329",
      attribute: "#0550ae",
      meta: "#1f2328",
      invalid: "#82071e",
      punctuation: "#24292f",
    },
  },
];

/** High-contrast light fallback if a theme omits syntaxLight. */
const SYNTAX_LIGHT_FALLBACK: SyntaxPalette = {
  keyword: "#a626a4",
  string: "#50a14f",
  comment: "#a0a1a7",
  number: "#986801",
  function: "#4078f2",
  type: "#c18401",
  className: "#c18401",
  property: "#e45649",
  variable: "#383a42",
  operator: "#0184bc",
  constant: "#986801",
  tag: "#e45649",
  attribute: "#986801",
  meta: "#4078f2",
  invalid: "#ff0000",
  punctuation: "#383a42",
};

/** Pick syntax palette for current app chrome. */
export function syntaxForChrome(
  theme: EditorTerminalTheme,
  appChrome: string,
): SyntaxPalette {
  if (chromeMode(appChrome) === "light") {
    return theme.syntaxLight ?? SYNTAX_LIGHT_FALLBACK;
  }
  return theme.syntax;
}

export function themeByKey(key: string): EditorTerminalTheme {
  return THEMES.find((t) => t.key === key) ?? THEMES[0]!;
}

export function isPaletteKey(key: string): boolean {
  return THEMES.some((t) => t.key === key);
}

/** App chrome mode from a theme / legacy palette key. */
export function chromeMode(key: string): "dark" | "light" {
  if (key === "light") return "light";
  if (key === "dark") return "dark";
  return themeByKey(key).chrome === "light" ? "light" : "dark";
}

/**
 * Fixed terminal palettes for app chrome only.
 * Code-block themes must NOT recolor the terminal — same as VS Code / JetBrains.
 */
const TERMINAL_DARK: NonNullable<ITerminalOptions["theme"]> = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#ffffff",
  cursorAccent: "#0c0c0c",
  selectionBackground: "#264f78",
  selectionInactiveBackground: "#3a3d41",
  black: "#0c0c0c",
  red: "#c50f1f",
  green: "#13a10e",
  yellow: "#c19c00",
  blue: "#0037da",
  magenta: "#881798",
  cyan: "#3a96dd",
  white: "#cccccc",
  brightBlack: "#767676",
  brightRed: "#e74856",
  brightGreen: "#16c60c",
  brightYellow: "#f9f1a5",
  brightBlue: "#3b78ff",
  brightMagenta: "#b4009e",
  brightCyan: "#61d6d6",
  brightWhite: "#f2f2f2",
};

const TERMINAL_LIGHT: NonNullable<ITerminalOptions["theme"]> = {
  background: "#ffffff",
  foreground: "#1e1e1e",
  cursor: "#1e1e1e",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  selectionInactiveBackground: "#e5ebf1",
  black: "#1e1e1e",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

/** xterm theme from app appearance (`dark` | `light`), not codeTheme. */
export function terminalThemeForChrome(
  mode: string,
): NonNullable<ITerminalOptions["theme"]> {
  return chromeMode(mode) === "light" ? TERMINAL_LIGHT : TERMINAL_DARK;
}

export function codeMirrorThemeExtensions(
  codeThemeKey: string,
  appChrome: string = "dark",
): Extension[] {
  const palette = themeByKey(codeThemeKey);
  const isLight = chromeMode(appChrome) === "light";
  const syntax = syntaxForChrome(palette, appChrome);
  const cursor = isLight ? "#18181b" : "#e4e4e7";
  const bg = isLight ? "#ffffff" : "#09090b";
  const fg = isLight ? "#18181b" : "#e4e4e7";
  const sel = isLight ? "#d4d4d8" : "#3f3f46";

  const chrome = EditorView.theme(
    {
      // Flex column so top search panel stays above the scroller (not mid-viewport sticky).
      "&": {
        backgroundColor: bg,
        color: fg,
        height: "100%",
        fontSize: "13px",
        display: "flex",
        flexDirection: "column",
      },
      ".cm-scroller": {
        backgroundColor: bg,
        fontFamily:
          "Cascadia Code, Consolas, ui-monospace, SFMono-Regular, Menlo, monospace",
        flex: "1 1 auto",
        minHeight: "0",
        overflow: "auto",
      },
      ".cm-content": { caretColor: cursor },
      "&.cm-focused .cm-cursor": { borderLeftColor: cursor },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
          backgroundColor: sel,
        },
      ".cm-activeLine": {
        backgroundColor: isLight
          ? "rgba(0,0,0,0.04)"
          : "rgba(255,255,255,0.04)",
      },
      ".cm-gutters": {
        backgroundColor: bg,
        color: isLight ? "#6e7781" : "#636d83",
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: isLight
          ? "rgba(0,0,0,0.04)"
          : "rgba(255,255,255,0.04)",
      },
      // ── Find / replace panel (CodeMirror search) ──
      // Override library sticky positioning so the panel never floats mid-pane.
      ".cm-panels": {
        position: "relative",
        left: "auto",
        right: "auto",
        top: "auto",
        bottom: "auto",
        zIndex: "5",
        flex: "0 0 auto",
        backgroundColor: isLight ? "#f4f4f5" : "#18181b",
        color: isLight ? "#18181b" : "#e4e4e7",
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: isLight ? "1px solid #e4e4e7" : "1px solid #27272a",
        order: "-1",
      },
      ".cm-panels.cm-panels-bottom": {
        borderTop: isLight ? "1px solid #e4e4e7" : "1px solid #27272a",
      },
      ".cm-panel.cm-search": {
        padding: "6px 8px",
        fontSize: "12px",
      },
      ".cm-panel.cm-search input[type=checkbox]": {
        marginRight: "4px",
      },
      ".cm-panel.cm-search label": {
        marginLeft: "6px",
        marginRight: "4px",
        color: isLight ? "#52525b" : "#a1a1aa",
      },
      ".cm-textfield": {
        backgroundColor: isLight ? "#ffffff" : "#09090b",
        color: isLight ? "#18181b" : "#e4e4e7",
        border: isLight ? "1px solid #d4d4d8" : "1px solid #3f3f46",
        borderRadius: "4px",
        padding: "3px 6px",
        outline: "none",
        marginRight: "4px",
      },
      ".cm-textfield:focus": {
        borderColor: isLight ? "#3b82f6" : "#38bdf8",
      },
      ".cm-button": {
        backgroundColor: isLight ? "#e4e4e7" : "#27272a",
        color: isLight ? "#18181b" : "#e4e4e7",
        border: isLight ? "1px solid #d4d4d8" : "1px solid #3f3f46",
        borderRadius: "4px",
        padding: "3px 8px",
        cursor: "pointer",
        marginRight: "4px",
      },
      ".cm-button:hover": {
        backgroundColor: isLight ? "#d4d4d8" : "#3f3f46",
      },
      ".cm-button:active": {
        backgroundColor: isLight ? "#a1a1aa" : "#52525b",
      },
      ".cm-panel.cm-search button[name=close]": {
        position: "absolute",
        right: "6px",
        top: "6px",
        background: "transparent",
        border: "none",
        color: isLight ? "#71717a" : "#a1a1aa",
        cursor: "pointer",
        fontSize: "16px",
        lineHeight: "1",
        padding: "2px 4px",
      },
      // Match highlights
      ".cm-searchMatch": {
        backgroundColor: isLight ? "#fef08a" : "#854d0e",
        outline: isLight ? "1px solid #facc15" : "1px solid #a16207",
      },
      ".cm-searchMatch-selected": {
        backgroundColor: isLight ? "#fdba74" : "#ca8a04",
        outline: isLight ? "1px solid #ea580c" : "1px solid #eab308",
      },
      ".cm-selectionMatch": {
        backgroundColor: isLight ? "#e0e7ff" : "#312e81",
      },
    },
    { dark: !isLight },
  );

  return [chrome, syntaxHighlighting(highlightStyleFrom(syntax))];
}
