/**
 * Import themes from external formats (iTerm2, VS Code) into EditorTerminalTheme.
 */

import type { EditorTerminalTheme, SyntaxPalette } from "./types";

// ── iTerm2 → EditorTerminalTheme ──────────────────────────────────────

interface ITerm2Colors {
  [key: string]: string | undefined;
  "Ansi 0 Color"?: string;
  "Ansi 1 Color"?: string;
  "Ansi 2 Color"?: string;
  "Ansi 3 Color"?: string;
  "Ansi 4 Color"?: string;
  "Ansi 5 Color"?: string;
  "Ansi 6 Color"?: string;
  "Ansi 7 Color"?: string;
  "Ansi 8 Color"?: string;
  "Ansi 9 Color"?: string;
  "Ansi 10 Color"?: string;
  "Ansi 11 Color"?: string;
  "Ansi 12 Color"?: string;
  "Ansi 13 Color"?: string;
  "Ansi 14 Color"?: string;
  "Ansi 15 Color"?: string;
  "Foreground Color"?: string;
  "Background Color"?: string;
  "Bold Color"?: string;
  "Cursor Color"?: string;
  "Cursor Text Color"?: string;
  "Selection Color"?: string;
  "Selected Text Color"?: string;
}

function parseITermColor(obj: any): string | null {
  if (!obj) return null;
  const r = obj["Red Component"] ?? obj["Red Component"];
  const g = obj["Green Component"] ?? obj["Green Component"];
  const b = obj["Blue Component"] ?? obj["Blue Component"];
  if (r == null || g == null || b == null) return null;
  const toByte = (v: number) => Math.round(v * 255);
  return `#${toByte(r).toString(16).padStart(2, "0")}${toByte(g).toString(16).padStart(2, "0")}${toByte(b).toString(16).padStart(2, "0")}`;
}

function extractITermColors(raw: any): ITerm2Colors {
  const colors: ITerm2Colors = {};
  for (const key of Object.keys(raw)) {
    const val = parseITermColor(raw[key]);
    if (val) colors[key] = val;
  }
  return colors;
}

function iterm2SyntaxPalette(colors: ITerm2Colors): SyntaxPalette {
  // Derive a reasonable syntax palette from terminal ANSI colors
  const fg = colors["Foreground Color"] ?? "#cccccc";
  const c1 = colors["Ansi 1 Color"] ?? "#cc5555"; // red
  const c2 = colors["Ansi 2 Color"] ?? "#55cc55"; // green
  const c3 = colors["Ansi 3 Color"] ?? "#cccc55"; // yellow
  const c4 = colors["Ansi 4 Color"] ?? "#5555cc"; // blue
  const c5 = colors["Ansi 5 Color"] ?? "#cc55cc"; // magenta
  const c6 = colors["Ansi 6 Color"] ?? "#55cccc"; // cyan
  const c7 = colors["Ansi 7 Color"] ?? "#cccccc"; // white
  return {
    keyword: c1, string: c2, comment: c3,
    number: c5, function: c4, type: c6,
    className: c4, property: c6, variable: fg,
    operator: c7, constant: c5, tag: c1,
    attribute: c3, meta: c3, invalid: c1,
    punctuation: c7,
  };
}

export function parseITermTheme(raw: string): EditorTerminalTheme | null {
  try {
    const json = JSON.parse(raw);
    const colors = extractITermColors(json);
    const fg = colors["Foreground Color"] ?? "#cccccc";
    const bg = colors["Background Color"] ?? "#000000";
    const cursor = colors["Cursor Color"] ?? "#ffffff";
    const sel = colors["Selection Color"] ?? "#555555";

    // Determine name from the object or from filename
    const name = json.name || json["Profile Name"] || "Imported iTerm2 Theme";

    return {
      label: name.replace(/\.itermcolors$/i, "").trim(),
      key: `imported-${Date.now().toString(36)}`,
      chrome: "dark",
      terminal: {
        background: bg,
        foreground: fg,
        cursor,
        selectionBackground: sel,
        selectionForeground: colors["Selected Text Color"] ?? fg,
        black: colors["Ansi 0 Color"] ?? "#000000",
        red: c1(colors), green: c2(colors),
        yellow: c3(colors), blue: c4(colors),
        magenta: c5(colors), cyan: c6(colors),
        white: c7(colors),
        brightBlack: colors["Ansi 8 Color"] ?? "#666666",
        brightRed: colors["Ansi 9 Color"] ?? c1(colors),
        brightGreen: colors["Ansi 10 Color"] ?? c2(colors),
        brightYellow: colors["Ansi 11 Color"] ?? c3(colors),
        brightBlue: colors["Ansi 12 Color"] ?? c4(colors),
        brightMagenta: colors["Ansi 13 Color"] ?? c5(colors),
        brightCyan: colors["Ansi 14 Color"] ?? c6(colors),
        brightWhite: colors["Ansi 15 Color"] ?? "#ffffff",
      },
      syntax: iterm2SyntaxPalette(colors),
    };
  } catch {
    return null;
  }
}

function c1(c: ITerm2Colors) { return c["Ansi 1 Color"] ?? "#cc5555"; }
function c2(c: ITerm2Colors) { return c["Ansi 2 Color"] ?? "#55cc55"; }
function c3(c: ITerm2Colors) { return c["Ansi 3 Color"] ?? "#cccc55"; }
function c4(c: ITerm2Colors) { return c["Ansi 4 Color"] ?? "#5555cc"; }
function c5(c: ITerm2Colors) { return c["Ansi 5 Color"] ?? "#cc55cc"; }
function c6(c: ITerm2Colors) { return c["Ansi 6 Color"] ?? "#55cccc"; }
function c7(c: ITerm2Colors) { return c["Ansi 7 Color"] ?? "#cccccc"; }

// ── VS Code → EditorTerminalTheme ─────────────────────────────────────

interface VSCodeColors {
  [key: string]: string;
}

function parseVSCodeColors(json: any): VSCodeColors {
  return json?.colors ?? {};
}

function vscodeToTerminal(colors: VSCodeColors) {
  const bg = colors["editor.background"] ?? "#1e1e1e";
  const fg = colors["editor.foreground"] ?? "#d4d4d4";
  return {
    background: bg,
    foreground: fg,
    cursor: colors["editorCursor.foreground"] ?? fg,
    selectionBackground: colors["editor.selectionBackground"] ?? "#264f78",
    selectionForeground: colors["editor.selectionForeground"] ?? fg,
    black: "#000000", red: "#cd3131", green: "#0dbc79",
    yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc",
    cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
    brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
    brightCyan: "#29b8db", brightWhite: "#ffffff",
  };
}

function vscodeToSyntax(colors: VSCodeColors, tokenColors: any[] | undefined): SyntaxPalette {
  // Default syntax derived from VS Code semantic token colors
  const fg = colors["editor.foreground"] ?? "#d4d4d4";
  const result: SyntaxPalette = {
    keyword: colors["editorToken.color"] ?? "#569cd6",
    string: colors["editorToken.string"] ?? "#ce9178",
    comment: colors["editorToken.comment"] ?? "#6a9955",
    number: colors["editorToken.number"] ?? "#b5cea8",
    function: colors["editorToken.function"] ?? "#dcdcaa",
    type: colors["editorToken.type"] ?? "#4ec9b0",
    className: colors["editorToken.class"] ?? "#4ec9b0",
    property: colors["editorToken.property"] ?? "#9cdcfe",
    variable: fg,
    operator: fg,
    constant: colors["editorToken.constant"] ?? "#4fc1ff",
    tag: colors["editorToken.tag"] ?? "#569cd6",
    attribute: colors["editorToken.attribute"] ?? "#9cdcfe",
    meta: colors["editorToken.meta"] ?? "#808080",
    invalid: colors["editorToken.invalid"] ?? "#f44747",
    punctuation: fg,
  };
  // Try to extract from tokenColors if available
  if (tokenColors) {
    for (const token of tokenColors) {
      const settings = token?.settings;
      if (!settings || !token.scope) continue;
      const scopes = Array.isArray(token.scope) ? token.scope : [token.scope];
      const color = settings.foreground;
      if (!color) continue;
      for (const scope of scopes) {
        if (typeof scope !== "string") continue;
        if (scope.includes("keyword")) result.keyword = color;
        else if (scope.includes("string")) result.string = color;
        else if (scope.includes("comment")) result.comment = color;
        else if (scope.includes("number") || scope.includes("numeric")) result.number = color;
        else if (scope.includes("function") || scope.includes("method")) result.function = color;
        else if (scope.includes("type") || scope.includes("interface")) result.type = color;
        else if (scope.includes("class")) result.className = color;
        else if (scope.includes("property") || scope.includes("attribute")) result.property = color;
        else if (scope.includes("variable")) result.variable = color;
        else if (scope.includes("constant") || scope.includes("literal")) result.constant = color;
        else if (scope.includes("operator")) result.operator = color;
        else if (scope.includes("tag")) result.tag = color;
      }
    }
  }
  return result;
}

export function parseVSCodeTheme(raw: string): EditorTerminalTheme | null {
  try {
    const json = JSON.parse(raw);
    const name = json.name || json.label || "Imported VS Code Theme";
    const colors = parseVSCodeColors(json);
    const tokenColors = json.tokenColors || json.semanticTokenColors || json.settings;
    return {
      label: name,
      key: `imported-${Date.now().toString(36)}`,
      chrome: "dark",
      terminal: vscodeToTerminal(colors),
      syntax: vscodeToSyntax(colors, tokenColors),
    };
  } catch {
    return null;
  }
}
