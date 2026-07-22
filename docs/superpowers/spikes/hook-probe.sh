#!/usr/bin/env bash
set -euo pipefail
OUT="$(mktemp)"
DIR="$(mktemp -d)"
# Nested schema (documented). The hook command writes the stdin payload to $OUT.
SETTINGS=$(cat <<JSON
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"cat > $OUT"}]}]}}
JSON
)
echo "=== running claude headless with inline --settings ==="
( cd "$DIR" && printf 'say hi and nothing else\n' | claude -p --settings "$SETTINGS" "say hi" || true )
echo "=== hook capture file contents ==="
cat "$OUT" || echo "(empty — hook did not fire)"
echo
echo "=== session_id present? ==="
grep -o '"session_id"[^,]*' "$OUT" || echo "(no session_id found)"
