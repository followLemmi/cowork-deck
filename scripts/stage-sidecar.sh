#!/usr/bin/env bash
# Builds a helper binary and stages it as a Tauri "externalBin" sidecar so
# `tauri build` bundles it next to the main executable. Tauri sidecars must be
# named "<name>-<target-triple>" (plus ".exe" on Windows) and live where
# tauri.conf.json's bundle.externalBin points.
#
#   scripts/stage-sidecar.sh cowork_report
#   scripts/stage-sidecar.sh cowork_task
#   scripts/stage-sidecar.sh --seed-only
#
# `--seed-only` writes the placeholders and stops, building nothing. That is
# enough for anything that only needs the crate to *compile* — `cargo test`
# included, because tauri-build's build.rs refuses to run while a declared
# externalBin is missing, while the tests themselves never touch the staged
# copies. CI uses it to avoid a release build of two binaries per run; the real
# staging stays covered by `tauri build` in the release workflow.
set -euo pipefail

BIN="${1:?usage: stage-sidecar.sh <bin-name> | --seed-only}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# `tauri build --target <triple>` exports the triple to its hooks; a sidecar
# staged for the host on a cross-build (x86_64 on an arm64 runner) would carry
# the wrong name AND the wrong architecture. Fall back to the host triple for
# plain local builds.
TARGET_TRIPLE="${TAURI_ENV_TARGET_TRIPLE:-$(rustc -Vv | grep host | cut -d' ' -f2)}"

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
# The list is read into a variable first: `set -e` aborts on a failed
# assignment, but ignores a substitution failing inside a `for` header, which
# would silently seed nothing and reproduce the very error this seeding
# prevents. Entries are kept as full config-relative paths (not basenames),
# so a sidecar living outside binaries/ still seeds where build.rs looks.
SIDECARS="$(node -p "require('./src-tauri/tauri.conf.json').bundle.externalBin.join('\n')")"
while IFS= read -r entry; do
  seed="src-tauri/${entry}-${TARGET_TRIPLE}${EXT}"
  mkdir -p "$(dirname "$seed")"
  if [ ! -e "$seed" ]; then
    install -m 0755 /dev/null "$seed"
  fi
done <<< "$SIDECARS"

if [ "$BIN" = "--seed-only" ]; then
  echo "Seeded sidecar placeholders for ${TARGET_TRIPLE}"
  exit 0
fi

# Building with an explicit --target keeps the output path deterministic
# (target/<triple>/release) whether or not this is a cross-build.
cargo build --release --bin "$BIN" --manifest-path src-tauri/Cargo.toml --target "$TARGET_TRIPLE"

# `cp` preserves the destination's existing mode rather than the source's, so
# a placeholder staged as 0644 would stay 0644 forever even after the real
# binary lands. `install -m` sets the mode explicitly on every run.
install -m 0755 "src-tauri/target/${TARGET_TRIPLE}/release/${BIN}${EXT}" "$DEST"

# Belt-and-suspenders: fail the build loudly if the staged sidecar somehow
# isn't executable, rather than letting it silently rot and only surface as
# a permission-denied failure at runtime inside the packaged app.
test -x "$DEST" || {
  echo "stage-sidecar.sh: staged sidecar '$DEST' is not executable" >&2
  exit 1
}

echo "Staged sidecar: $DEST"
