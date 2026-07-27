#!/usr/bin/env bash
# Builds the cowork_memory sidecar and stages it as a Tauri "externalBin"
# next to cowork_report. Mirrors scripts/stage-reporter.sh.
#
#   npm run stage:memory
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET_TRIPLE="$(rustc -Vv | grep host | cut -d' ' -f2)"

EXT=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
esac

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/cowork_memory-${TARGET_TRIPLE}${EXT}"

# Seed a placeholder, as stage-reporter.sh does. tauri-build's build.rs
# validates that every bundle.externalBin resource exists on disk during *any*
# cargo build of the app crate. cowork_memory is deliberately not declared in
# tauri.conf.json yet — that lands in phase 3, when the app starts spawning it —
# so this is inert for now and correct from the moment it is declared.
if [ ! -e "$DEST" ]; then
  : > "$DEST"
fi

cargo build --release --bin cowork_memory --manifest-path crates/cowork-memory/Cargo.toml

SRC="crates/cowork-memory/target/release/cowork_memory${EXT}"
cp "$SRC" "$DEST"
echo "Staged memory sidecar: $DEST"
