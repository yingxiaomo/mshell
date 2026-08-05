@echo off
call "D:\Dev\Microsoft Visual Studio\18\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
cd /d D:\Github\momoshell
cargo build -p momoshell
if errorlevel 1 exit /b 1
start "" "D:\Github\momoshell\target\debug\momoshell.exe"
