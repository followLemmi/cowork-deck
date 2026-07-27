#!/usr/bin/env bash
# Builds a helper binary and stages it as a Tauri "externalBin" sidecar so
# `tauri build` bundles it next to the main executable. Tauri sidecars must be
# named "<name>-<target-triple>" (plus ".exe" on Windows) and live where
# tauri.conf.json's bundle.externalBin points.
#
#   scripts/stage-sidecar.sh cowork_report
#   scripts/stage-sidecar.sh cowork_task
set -euo pipefail

BIN="${1:?usage: stage-sidecar.sh <bin-name>}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

TARGET_TRIPLE="$(rustc -Vv | grep host | cut -d' ' -f2)"

EXT=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
esac

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/${BIN}-${TARGET_TRIPLE}${EXT}"

# tauri-build's build.rs validates that every bundle.externalBin resource
# already exists on disk, and it runs on *any* cargo build of this crate.
# Seed a placeholder first so that build doesn't fail before we've produced
# the real binary.
if [ ! -e "$DEST" ]; then
  : > "$DEST"
fi

cargo build --release --bin "$BIN" --manifest-path src-tauri/Cargo.toml

cp "src-tauri/target/release/${BIN}${EXT}" "$DEST"
echo "Staged sidecar: $DEST"
