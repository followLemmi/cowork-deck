#!/usr/bin/env bash
# Builds the cowork_memory sidecar and stages it where tauri.conf.json's
# bundle.externalBin will look for it.
#
#   npm run stage:memory
#
# Not scripts/stage-sidecar.sh, and the difference is the crate rather than the
# staging: cowork_memory lives in crates/cowork-memory with a target directory
# of its own, deliberately outside any root [workspace] — one would move
# src-tauri's target directory and break stage-reporter.sh. That script builds
# from src-tauri/Cargo.toml and has no way to reach this crate. Everything after
# the build is deliberately identical to it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# `tauri build --target <triple>` exports the triple to its hooks; a sidecar
# staged for the host on a cross-build would carry the wrong name AND the wrong
# architecture. Fall back to the host triple for plain local builds.
TARGET_TRIPLE="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -Vv | grep host | cut -d' ' -f2)}"

EXT=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) EXT=".exe" ;;
esac

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/cowork_memory-${TARGET_TRIPLE}${EXT}"

# A placeholder, executable from the start. cowork_memory is not declared in
# tauri.conf.json yet — that lands when the app starts spawning it — so this is
# inert today and correct from the moment it is declared. `install -m 0755`
# rather than a redirect, so a placeholder never sits there non-executable.
if [ ! -e "$DEST" ]; then
  install -m 0755 /dev/null "$DEST"
fi

cargo build --release --bin cowork_memory \
  --manifest-path crates/cowork-memory/Cargo.toml --target "$TARGET_TRIPLE"

# `install -m`, not `cp`: cp preserves the *destination's* mode, so a
# placeholder created 0644 would stay 0644 forever, and the packaged app would
# fail with permission denied at the first spawn rather than at build time.
install -m 0755 \
  "crates/cowork-memory/target/${TARGET_TRIPLE}/release/cowork_memory${EXT}" "$DEST"

test -x "$DEST" || {
  echo "stage-memory.sh: staged sidecar '$DEST' is not executable" >&2
  exit 1
}

echo "Staged memory sidecar: $DEST"
