#!/usr/bin/env bash
# Ask the running stocks server to restart in place (SIGHUP -> exit 42, which
# the run.sh supervisor catches and relaunches). Requires the server to have
# been started via ./run.sh.
#
# Usage: ./restart.sh
set -euo pipefail
cd "$(dirname "$0")"

pidfile="server.pid"
if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
  pid="$(cat "$pidfile")"
  kill -HUP "$pid" && echo "sent SIGHUP to $pid — server restarting"
elif pkill -HUP -f '[p]ython.* app\.py'; then
  echo "sent SIGHUP via pkill — server restarting"
else
  echo "no running server found (server.pid stale and no app.py process)" >&2
  exit 1
fi
