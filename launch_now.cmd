@echo off
REM Debug builds are compiled with cfg(dev) and load http://localhost:1420.
REM Always start via tauri dev so Vite is up; bare .exe shows WebView "拒绝访问".
cd /d "%~dp0"
call npm run tauri dev
