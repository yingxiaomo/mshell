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
    port: 1420,
    strictPort: true,
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
  },
}));
