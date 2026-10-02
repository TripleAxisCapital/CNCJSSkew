#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIDGET_DIR="$ROOT_DIR/widget"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required (CNCjs already requires Node.js)." >&2
  exit 1
fi

node "$ROOT_DIR/scripts/configure.js" install "$WIDGET_DIR"

echo
echo "CNCJSSkew is installed locally."
echo "1) Restart CNCjs."
echo "2) Open CNCjs in your browser."
echo "3) Manage Widgets -> add a Custom Widget."
echo "4) Set the Custom Widget URL to: /cncjs-skew/"
echo
echo "No internet connection is required after this installation."
