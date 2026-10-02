#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$ROOT_DIR/scripts/configure.js" uninstall
echo "Restart CNCjs to finish removing the local mount."
