import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useSettingsStore } from "./stores/settings";
import { initEarlyTerminalBuffer } from "./lib/events";

// Load persisted settings (theme / terminal font / reconnect prefs) ASAP.
void useSettingsStore.getState().load();

// Start listening for terminal output immediately so early shell MOTD
// is not lost between session_open and TerminalView mount.
void initEarlyTerminalBuffer();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
