#!/usr/bin/env bash
# What memory sync would publish, shown before any repository exists.
#
#   scripts/sync-preview.sh [config-dir]
#
# Run this before switching sync on for the first time, and again after any
# change to the allowlist. It is the one check worth doing first: every other
# failure in this feature is recoverable, and publishing a credential is not —
# a private repository is still GitHub's servers, and deleting it afterwards
# does not unsend it.
#
# Works on a *copy*, and never writes to the directory it is inspecting. The
# ignore rules come from `sync::manifest` itself rather than a second copy of
# them here, which is the whole point: a preview that agrees with a
# reimplementation and not with the app would be worse than none.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEFAULT_DIR="$HOME/Library/Application Support/ca.jvl.coworkdeck"
case "$(uname -s)" in
  Linux*)               DEFAULT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ca.jvl.coworkdeck" ;;
  MINGW*|MSYS*|CYGWIN*) DEFAULT_DIR="${APPDATA:-$HOME}/ca.jvl.coworkdeck" ;;
esac
SRC="${1:-$DEFAULT_DIR}"

if [ ! -d "$SRC" ]; then
  echo "No config directory at: $SRC" >&2
  echo "Pass one as the first argument if the app keeps it elsewhere." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# `cargo test` rather than a copy of the rules: this must be the same text the
# app writes, or the preview reassures about something that is not what ships.
cargo test --manifest-path src-tauri/Cargo.toml \
  sync::manifest::tests::print_the_ignore -- --ignored --nocapture 2>/dev/null \
  | sed -n '/^# Generated/,/^\.model/p' > "$WORK/ignore"

if [ ! -s "$WORK/ignore" ]; then
  echo "Could not generate the ignore rules — is the crate building?" >&2
  exit 1
fi

cp -R "$SRC/." "$WORK/tree/" 2>/dev/null || { mkdir -p "$WORK/tree"; cp -R "$SRC/." "$WORK/tree/"; }
chmod -R u+w "$WORK/tree" 2>/dev/null || true
cp "$WORK/ignore" "$WORK/tree/.gitignore"

cd "$WORK/tree"
# A repository of its own, in a temporary directory: the real one is never
# touched, and this cannot accidentally push anything anywhere.
rm -rf .git
git init -q .
git add -A 2>/dev/null || true

echo "Reading: $SRC"
echo
echo "WOULD BE PUBLISHED"
echo "──────────────────"
git ls-files | sed 's/^/  /'
echo
echo "WOULD STAY ON THIS MACHINE"
echo "──────────────────────────"
git status --porcelain --ignored=matching | grep '^!!' | sed 's/^!! /  /' || echo "  (nothing)"
echo
echo "Read the first list. Anything in it that you would not put in a private"
echo "repository is a bug — report it rather than switching sync on."
