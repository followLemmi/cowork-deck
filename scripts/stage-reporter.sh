#!/usr/bin/env bash
# Kept for compatibility: stages the reporter sidecar.
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/stage-sidecar.sh" cowork_report
