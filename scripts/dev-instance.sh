#!/usr/bin/env bash
# A second copy of the app in dev mode, beside the one already running from
# another checkout or worktree.
#
#   npm run dev:instance                                        # this checkout, port 1421
#   npm run dev:instance -- --dir .claude/worktrees/limit-dials  # that one
#   npm run dev:instance -- --port 1422 --slot review
#
# Two things collide when `npm run tauri dev` runs twice on one machine, and
# neither is a port on its own:
#
#   * **The dev server.** `vite.config.ts` pins 1420 with `strictPort`, and
#     `devUrl` points the webview at that same number, so a second server has
#     nowhere to go. Three things have to move together, and all three move here:
#     `beforeDevCommand` gains a `--port` for Vite, `devUrl` follows it, and so
#     does the dev CSP, which names the websocket the hot reload connects on.
#
#   * **The single-instance claim** (src-tauri/src/instance.rs). It is a lock on
#     the *config directory*, and Tauri derives that directory from the bundle
#     identifier — so two copies sharing an identifier are two copies sharing a
#     store, a run journal, a memory corpus and the git repository the sync cycle
#     commits, which is the contention the lock exists to refuse. Giving this
#     copy an identifier suffix gives it a config directory of its own, and the
#     claim then has nothing to refuse: as instance.rs puts it, two processes
#     that do not share a directory are contending over nothing.
#
# Its state therefore starts empty — separate directory, separate everything.
# That is the point when the second copy is there to check a change, and it is
# why this is a dev script and not a setting: nothing here reaches the release
# configuration. `--config` merges over tauri.conf.json for this run only and
# the file on disk is untouched.
#
# Nothing is overridden through a checked-in file for a second reason, and it is
# the reason `--dir` exists: the copy being checked usually sits in a worktree on
# another branch, and a script is no help there either way — untracked, it is not
# shared between worktrees; committed, it arrives only once that branch merges
# trunk. So the checkout to launch is an argument rather than wherever this file
# happens to live, and one copy of the script can start a worktree whose branch
# has never heard of it. Everything is read from that checkout — its
# tauri.conf.json, and the branch its slot defaults to — because everything below
# runs after changing into it.
set -euo pipefail

# Resolved before the `cd`, because a relative $BASH_SOURCE does not survive it
# and `usage` reads this file.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

PORT="${COWORK_DEV_PORT:-1421}"
SLOT="${COWORK_DEV_SLOT:-}"
DIR="${COWORK_DEV_DIR:-$(dirname "$SELF")/..}"

usage() {
  sed -n '2,7p' "$SELF" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --slot) SLOT="${2:?--slot needs a name}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "dev-instance.sh: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) echo "dev-instance.sh: --port takes a number, got '$PORT'" >&2; exit 2 ;;
esac

cd "$DIR" 2>/dev/null || {
  echo "dev-instance.sh: --dir '$DIR' is not a directory" >&2
  exit 2
}
# The checkout is named rather than assumed, so it is also checked: `tauri dev`
# in the wrong directory fails much later and much less clearly.
test -f src-tauri/tauri.conf.json || {
  echo "dev-instance.sh: $PWD is not a cowork-deck checkout (no src-tauri/tauri.conf.json)" >&2
  exit 2
}

# The slot names the config directory, so it defaults to the branch: one
# directory per line of work, kept across runs, rather than a fresh one every
# launch. Anything an identifier cannot carry becomes a hyphen, and the length is
# capped because the result is a directory name a person has to read.
if [ -z "$SLOT" ]; then
  SLOT="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo alt)"
fi
SLOT="$(printf '%s' "$SLOT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | cut -c1-32)"
SLOT="$(printf '%s' "$SLOT" | sed -e 's/-\{2,\}/-/g' -e 's/^-//' -e 's/-$//')"
SLOT="${SLOT:-alt}"

# `strictPort` would catch this too, but from inside the Tauri output, several
# hundred lines after the cargo build it made you wait for.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  exec 3>&-
  echo "dev-instance.sh: something is already listening on port $PORT; pass --port with a free one." >&2
  exit 1
fi

CONFIG="$(COWORK_DEV_PORT="$PORT" COWORK_DEV_SLOT="$SLOT" node -e '
const conf = require("./src-tauri/tauri.conf.json");
const port = process.env.COWORK_DEV_PORT;
const slot = process.env.COWORK_DEV_SLOT;
// Vite takes the port on the command line, where it wins over the config file.
// Anchored to the end of the hook, and fatal when it does not match: a silent
// no-op here would start the second server on 1420 and hand the failure to
// `strictPort` several hundred lines later.
const before = conf.build.beforeDevCommand;
if (!/npm run dev$/.test(before)) {
  console.error("dev-instance.sh: beforeDevCommand no longer ends in `npm run dev`; teach this script the new shape.");
  process.exit(1);
}
// The merge replaces arrays rather than merging them, so the window is spread
// whole and only the title changed: two identical windows on one screen is a
// question nobody should have to answer by clicking on them.
const win = { ...conf.app.windows[0], title: `${conf.app.windows[0].title} (${slot})` };
console.log(JSON.stringify({
  identifier: `${conf.identifier}.${slot}`,
  build: {
    devUrl: `http://localhost:${port}`,
    beforeDevCommand: `${before} -- --port ${port}`,
  },
  app: {
    windows: [win],
    security: { devCsp: conf.app.security.devCsp.split("1420").join(port) },
  },
}));
')"

IDENTIFIER="$(printf '%s' "$CONFIG" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).identifier')"
case "$(uname -s)" in
  Darwin) CONFIG_DIR="$HOME/Library/Application Support/$IDENTIFIER" ;;
  *)      CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/$IDENTIFIER" ;;
esac

echo "cowork-deck ($SLOT)"
echo "  checkout    $PWD"
echo "  dev server  http://localhost:$PORT"
echo "  identifier  $IDENTIFIER"
echo "  config dir  $CONFIG_DIR"
echo "              its own store, run journal, memory corpus and sync repository,"
echo "              so this copy starts with no workspaces and syncs nowhere."
echo

exec npx tauri dev --config "$CONFIG"
