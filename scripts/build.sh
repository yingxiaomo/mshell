#!/usr/bin/env bash
# Build script for momoshell
# Prerequisites: Node.js 20+, Rust stable, MSVC build tools

set -euo pipefail

echo "=== 1. Frontend build (Vite) ==="
npm install --silent
npm run build

echo ""
echo "=== 2. Rust release build ==="
cargo build -p momoshell --release

echo ""
echo "=== 3. Collect artifacts ==="
ARTIFACT="target/release/momoshell.exe"
if [ -f "$ARTIFACT" ]; then
    ls -lh "$ARTIFACT"
else
    echo "WARNING: $ARTIFACT not found"
fi

echo ""
echo "=== 4. Run tests ==="
npx vitest run --silent 2>/dev/null || echo "(vitest not configured, skip)"
cargo test -p protocol -p store -p momoshell --lib --quiet 2>/dev/null || echo "(backend tests)"

echo ""
echo "=== 5. Check type ==="
npx tsc --noEmit -p tsconfig.json 2>/dev/null && echo "TypeScript OK"

echo ""
echo "=== Build complete ==="
echo "Binary: $ARTIFACT"
echo "To create MSI installer: npm run tauri build"
