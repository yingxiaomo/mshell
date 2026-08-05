import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: Number(process.env.PORT) || 1420,
    strictPort: !process.env.PORT,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Ignore rust crates to avoid reloads on cargo rebuilds
      ignored: ["**/crates/**", "**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],

  // Pre-bundle CodeMirror legacy modes so Tauri's webview doesn't slow down on
  // first page load (50+ legacy mode modules compiled on-the-fly ≈ several seconds).
  optimizeDeps: {
    include: [
      "@codemirror/legacy-modes/mode/shell",
      "@codemirror/legacy-modes/mode/yaml",
      "@codemirror/legacy-modes/mode/toml",
      "@codemirror/legacy-modes/mode/rust",
      "@codemirror/legacy-modes/mode/go",
      "@codemirror/legacy-modes/mode/sql",
      "@codemirror/legacy-modes/mode/properties",
      "@codemirror/legacy-modes/mode/nginx",
      "@codemirror/legacy-modes/mode/dockerfile",
      "@codemirror/legacy-modes/mode/clike",
      "@codemirror/legacy-modes/mode/powershell",
      "@codemirror/legacy-modes/mode/ruby",
      "@codemirror/legacy-modes/mode/perl",
      "@codemirror/legacy-modes/mode/lua",
      "@codemirror/legacy-modes/mode/python",
      "@codemirror/legacy-modes/mode/r",
      "@codemirror/legacy-modes/mode/swift",
      "@codemirror/legacy-modes/mode/groovy",
      "@codemirror/legacy-modes/mode/haskell",
      "@codemirror/legacy-modes/mode/julia",
      "@codemirror/legacy-modes/mode/erlang",
      "@codemirror/legacy-modes/mode/elm",
      "@codemirror/legacy-modes/mode/clojure",
      "@codemirror/legacy-modes/mode/coffeescript",
      "@codemirror/legacy-modes/mode/livescript",
      "@codemirror/legacy-modes/mode/tcl",
      "@codemirror/legacy-modes/mode/vb",
      "@codemirror/legacy-modes/mode/vbscript",
      "@codemirror/legacy-modes/mode/pascal",
      "@codemirror/legacy-modes/mode/fortran",
      "@codemirror/legacy-modes/mode/cmake",
      "@codemirror/legacy-modes/mode/diff",
      "@codemirror/legacy-modes/mode/sass",
      "@codemirror/legacy-modes/mode/stylus",
      "@codemirror/legacy-modes/mode/protobuf",
      "@codemirror/legacy-modes/mode/gas",
      "@codemirror/legacy-modes/mode/octave",
      "@codemirror/legacy-modes/mode/sparql",
      "@codemirror/legacy-modes/mode/verilog",
      "@codemirror/legacy-modes/mode/vhdl",
    ],
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            "codemirror",
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/search",
            "@codemirror/theme-one-dark",
            "@codemirror/lang-javascript",
            "@codemirror/lang-json",
            "@codemirror/lang-html",
            "@codemirror/lang-xml",
            "@codemirror/lang-python",
            "@codemirror/lang-css",
            "@codemirror/lang-markdown",
          ],
          xterm: [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-search",
            "@xterm/addon-web-links",
          ],
          vendor: ["react", "react-dom", "zustand", "lucide-react", "clsx"],
        },
      },
    },
  },

  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Component tests use // @vitest-environment jsdom pragma
    environmentOptions: {
      jsdom: {
        pretendToBeVisual: true,
      },
    },
  },
}));
