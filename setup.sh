#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo
echo "CNCJSSkew Setup"
echo "==============="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo "CNCjs normally includes/depends on Node.js. Install Node.js/CNCjs first, then run this setup again."
  exit 1
fi

echo "1/3  Checking CNCJSSkew..."
node --test "$ROOT_DIR"/tests/*.test.js >/tmp/cncjsskew-test.log 2>&1 || {
  cat /tmp/cncjsskew-test.log
  echo
  echo "Setup stopped because the self-test failed."
  exit 1
}
echo "     OK"

echo "2/3  Installing the local CNCjs widget..."
"$ROOT_DIR/install.sh" >/tmp/cncjsskew-install.log 2>&1 || {
  cat /tmp/cncjsskew-install.log
  echo
  echo "Setup stopped because installation failed."
  exit 1
}
echo "     OK"

echo "3/3  Restarting CNCjs if it can be identified automatically..."
RESTARTED=0

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe cncjs >/dev/null 2>&1; then
    pm2 restart cncjs >/dev/null
    RESTARTED=1
    echo "     Restarted PM2 process: cncjs"
  elif pm2 describe CNCjs >/dev/null 2>&1; then
    pm2 restart CNCjs >/dev/null
    RESTARTED=1
    echo "     Restarted PM2 process: CNCjs"
  fi
fi

if [ "$RESTARTED" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files cncjs.service >/dev/null 2>&1; then
    if sudo systemctl restart cncjs; then
      RESTARTED=1
      echo "     Restarted systemd service: cncjs"
    fi
  fi
fi

if [ "$RESTARTED" -eq 0 ]; then
  echo "     CNCjs restart was not automatic."
  echo "     Restart CNCjs the same way you normally do."
fi

echo
echo "Ready."
echo
echo "In CNCjs:"
echo "  Manage Widgets -> Add Custom Widget"
echo "  Widget URL: /cncjs-skew/"
echo
echo "After that, the widget is fully local and works offline."
echo
