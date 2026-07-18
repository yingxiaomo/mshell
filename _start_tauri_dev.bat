@echo off
setlocal
call "D:\Dev\Microsoft Visual Studio\18\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
cd /d D:\Github\momoshell
echo Starting momoshell (tauri dev)...
npm run tauri dev
endlocal
