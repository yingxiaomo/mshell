@echo off
REM Build script for mshell — initializes MSVC environment then builds.
REM Use this instead of bare "cargo build" from cmd/PowerShell.

call "D:\Dev\Microsoft Visual Studio\18\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
cargo build -p mshell --release %*
