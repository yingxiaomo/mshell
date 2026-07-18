import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useSettingsStore } from "./stores/settings";
import { initEarlyTerminalBuffer } from "./lib/events";
import {
  hydrateLayoutFromSettings,
  startLayoutPersistence,
} from "./lib/layoutPersist";

// Wait for global event buffer subscription before rendering, so early
// terminal output (MOTD/prompt) is never lost.
void (async () => {
  await useSettingsStore.getState().load();
  hydrateLayoutFromSettings();
  startLayoutPersistence();
  await initEarlyTerminalBuffer();

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
})();
