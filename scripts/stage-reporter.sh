#!/usr/bin/env bash
# Builds the cowork_report reporter binary and stages it as a Tauri
# "externalBin" sidecar so `tauri build` bundles it next to the main
# executable. Tauri sidecars must be named "<name>-<target-triple>"
# (plus ".exe" on Windows) and live where tauri.conf.json's
# bundle.externalBin points (src-tauri/binaries/cowork_report).
#
# Invoked automatically via `build.beforeBuildCommand` in
# src-tauri/tauri.conf.json, and can also be run manually:
#   npm run stage:reporter
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET_TRIPLE="$(rustc -Vv | grep host | cut -d' ' -f2)"

EXT=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
esac

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/cowork_report-${TARGET_TRIPLE}${EXT}"

# tauri-build's build.rs validates that every bundle.externalBin resource
# already exists on disk, and it runs on *any* cargo build of this crate
# (main bin or reporter bin alike). Seed a placeholder first so that build
# doesn't fail before we've produced the real binary.
if [ ! -e "$DEST" ]; then
  : > "$DEST"
fi

cargo build --release --bin cowork_report --manifest-path src-tauri/Cargo.toml

SRC="src-tauri/target/release/cowork_report${EXT}"
cp "$SRC" "$DEST"
echo "Staged reporter sidecar: $DEST"
