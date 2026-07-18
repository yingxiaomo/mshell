import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useSettingsStore } from "./stores/settings";

// Load persisted settings (theme / terminal font / reconnect prefs) ASAP.
void useSettingsStore.getState().load();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
