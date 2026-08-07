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
# already exists on disk, and it runs on *any* cargo build of this crate —
# including the one below that produces just $BIN. Seed placeholders for ALL
# sidecars listed in tauri.conf.json, not only the one being staged, or a
# clean checkout deadlocks: staging the first sidecar fails on the missing
# second one. Seed them executable too, so even the pre-build state is
# correct (and so a stale placeholder left over from a failed run doesn't
# masquerade as a valid, non-executable sidecar).
for sidecar in $(node -p "require('./src-tauri/tauri.conf.json').bundle.externalBin.map(p => p.split('/').pop()).join(' ')"); do
  seed="src-tauri/binaries/${sidecar}-${TARGET_TRIPLE}${EXT}"
  if [ ! -e "$seed" ]; then
    install -m 0755 /dev/null "$seed"
  fi
done

cargo build --release --bin "$BIN" --manifest-path src-tauri/Cargo.toml

# `cp` preserves the destination's existing mode rather than the source's, so
# a placeholder staged as 0644 would stay 0644 forever even after the real
# binary lands. `install -m` sets the mode explicitly on every run.
install -m 0755 "src-tauri/target/release/${BIN}${EXT}" "$DEST"

# Belt-and-suspenders: fail the build loudly if the staged sidecar somehow
# isn't executable, rather than letting it silently rot and only surface as
# a permission-denied failure at runtime inside the packaged app.
test -x "$DEST" || {
  echo "stage-sidecar.sh: staged sidecar '$DEST' is not executable" >&2
  exit 1
}

echo "Staged sidecar: $DEST"
