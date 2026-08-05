import {
  StreamLanguage,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { go } from "@codemirror/legacy-modes/mode/go";
import { sql } from "@codemirror/legacy-modes/mode/sql";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import {
  c,
  cpp,
  java,
  csharp,
  scala,
  kotlin,
  objectiveC,
  objectiveCpp,
  dart,
} from "@codemirror/legacy-modes/mode/clike";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r } from "@codemirror/legacy-modes/mode/r";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { elm } from "@codemirror/legacy-modes/mode/elm";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { liveScript } from "@codemirror/legacy-modes/mode/livescript";
import { tcl } from "@codemirror/legacy-modes/mode/tcl";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { vbScript } from "@codemirror/legacy-modes/mode/vbscript";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { fortran } from "@codemirror/legacy-modes/mode/fortran";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { stylus } from "@codemirror/legacy-modes/mode/stylus";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { gas } from "@codemirror/legacy-modes/mode/gas";
import { octave } from "@codemirror/legacy-modes/mode/octave";
import { sparql } from "@codemirror/legacy-modes/mode/sparql";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";

const stream = StreamLanguage.define;

/**
 * Detect language from a `#!` shebang line (for extensionless scripts).
 */
export function languageFromShebang(doc: string): Extension | undefined {
  const first = doc.split(/\r?\n/, 1)[0] ?? "";
  if (!first.startsWith("#!")) return undefined;
  const line = first.slice(2).toLowerCase();

  if (
    line.includes("python") ||
    line.includes("pypy") ||
    /\/env\s+python/.test(line)
  ) {
    return python();
  }
  if (
    line.includes("node") ||
    line.includes("nodejs") ||
    line.includes("bun") ||
    line.includes("deno")
  ) {
    return javascript();
  }
  if (line.includes("ruby") || line.includes("jruby")) {
    return stream(ruby);
  }
  if (line.includes("perl")) {
    return stream(perl);
  }
  if (line.includes("lua")) {
    return stream(lua);
  }
  if (line.includes("php")) {
    return stream(shell);
  }
  if (
    line.includes("bash") ||
    line.includes("sh") ||
    line.includes("zsh") ||
    line.includes("ksh") ||
    line.includes("dash") ||
    line.includes("fish") ||
    line.includes("ash")
  ) {
    return stream(shell);
  }
  if (line.includes("pwsh") || line.includes("powershell")) {
    return stream(powerShell);
  }
  if (line.includes("osascript")) {
    return stream(shell);
  }
  return undefined;
}

/** File-name-specific (not extension-based) language mapping. */
const SPECIAL_NAMES: Record<string, () => Extension | undefined> = {
  "dockerfile": () => stream(dockerFile),
  "containerfile": () => stream(dockerFile),
  "nginx.conf": () => stream(nginx),
  "makefile": () => stream(shell),
  "gemfile": () => stream(ruby),
  "rakefile": () => stream(ruby),
  "cmakelists.txt": () => stream(cmake),
  "cargo.toml": () => stream(toml),
  "go.mod": () => stream(go),
  "go.sum": () => undefined,
  ".env": () => stream(shell),
  ".env.example": () => stream(shell),
  "gradle": () => stream(groovy),
  ".gitignore": () => stream(properties),
  ".dockerignore": () => stream(properties),
  ".editorconfig": () => stream(properties),
  ".npmrc": () => stream(properties),
};

/**
 * Language mode from file path / name (+ optional doc for shebang).
 * Returns undefined for unknown types (plain text — only chrome colors apply).
 */
export function languageExtensionForPath(
  path: string,
  doc?: string,
): Extension | undefined {
  const base = path.split(/[/\\]/).pop() ?? path;
  const lower = base.toLowerCase();

  // Full-name specials first (Cargo.toml, Dockerfile, …)
  const byName = SPECIAL_NAMES[lower];
  if (byName) {
    const ext = byName();
    if (ext) return ext;
  }

  // Strip compound suffixes like .d.ts / .spec.ts handled via last extension.
  const ext = lower.includes(".")
    ? lower.slice(lower.lastIndexOf(".") + 1)
    : "";

  // Double-extension helpers: foo.service, foo.conf.d entries still use last ext.
  switch (ext) {
    case "js":
    case "cjs":
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "json":
    case "jsonc":
    case "json5":
    case "webmanifest":
      return json();
    case "py":
    case "pyw":
    case "pyi":
    case "py3":
      return python();
    case "html":
    case "htm":
    case "vue":
    case "svelte":
    case "hbs":
    case "ejs":
    case "njk":
      return html();
    case "xml":
    case "svg":
    case "xsl":
    case "xslt":
    case "plist":
    case "xsd":
    case "wsdl":
    case "csproj":
    case "fsproj":
    case "vbproj":
    case "props":
    case "targets":
      return xml();
    case "css":
    case "less":
      return css();
    case "scss":
    case "sass":
      return stream(sass);
    case "styl":
      return stream(stylus);
    case "md":
    case "mdx":
    case "markdown":
      return markdown();
    case "rs":
      return stream(rust);
    case "go":
      return stream(go);
    case "rb":
      return stream(ruby);
    case "pyb":
      return python();
    case "sh":
    case "bash":
    case "zsh":
    case "ksh":
    case "dash":
    case "fish":
    case "ash":
      return stream(shell);
    case "ps1":
    case "psm1":
    case "psd1":
      return stream(powerShell);
    case "pl":
    case "pm":
      return stream(perl);
    case "lua":
      return stream(lua);
    case "sql":
      return stream(sql({}));
    case "yaml":
    case "yml":
      return stream(yaml);
    case "toml":
      return stream(toml);
    case "ini":
    case "cfg":
    case "conf":
      return stream(properties);
    case "editorconfig":
      return stream(properties);
    case "dockerfile":
      return stream(dockerFile);
    case "nginx":
      return stream(nginx);
    case "c":
    case "h":
      return stream(c);
    case "cpp":
    case "cxx":
    case "cc":
    case "hpp":
    case "hxx":
      return stream(cpp);
    case "java":
    case "class":
      return stream(java);
    case "cs":
      return stream(csharp);
    case "kt":
    case "kts":
      return stream(kotlin);
    case "scala":
      return stream(scala);
    case "dart":
      return stream(dart);
    case "swift":
      return stream(swift);
    case "r":
    case "rdata":
    case "rds":
      return stream(r);
    case "mjs":
      return javascript();
    case "jl":
      return stream(julia);
    case "ex":
    case "exs":
      // No Elixir mode available — use Erlang highlighting as closest.
      return stream(erlang);
    case "clj":
    case "cljs":
    case "cljc":
    case "edn":
      return stream(clojure);
    case "hs":
    case "lhs":
      return stream(haskell);
    case "erl":
      return stream(erlang);
    case "elm":
      return stream(elm);
    case "coffee":
      return stream(coffeeScript);
    case "litcoffee":
      return stream(coffeeScript);
    case "livescript":
      return stream(liveScript);
    case "tcl":
      return stream(tcl);
    case "vb":
      return stream(vb);
    case "vbs":
      return stream(vbScript);
    case "pp":
    case "pas":
      return stream(pascal);
    case "f":
    case "for":
    case "f90":
    case "f95":
      return stream(fortran);
    case "cmake":
      return stream(cmake);
    case "diff":
    case "patch":
      return stream(diff);
    case "proto":
      return stream(protobuf);
    case "s":
    case "asm":
      return stream(gas);
    case "m":
      return stream(objectiveC);
    case "mm":
      return stream(objectiveCpp);
    case "groovy":
    case "gradle":
      return stream(groovy);
    case "sparql":
      return stream(sparql);
    case "v":
    case "vhdl":
      return stream(vhdl);
    case "vh":
    case "sv":
    case "svh":
    case "vhd":
      return stream(verilog);
    case "oct":
      return stream(octave);
    case "awk":
    case "nawk":
    case "gawk":
      return stream(shell);
    case "nim":
      return python(); // closest available — not accurate
    case "zig":
      return stream(rust); // closest available — not accurate
    default: {
      // Extensionless: fall back to shebang if document provided.
      if (!ext && doc) {
        return languageFromShebang(doc);
      }
      if (
        lower.endsWith(".sh") ||
        lower.endsWith(".bash") ||
        lower.endsWith(".zsh")
      ) {
        return stream(shell);
      }
      if (doc) {
        return languageFromShebang(doc);
      }
      return undefined;
    }
  }
}