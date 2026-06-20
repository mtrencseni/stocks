#!/usr/bin/env bash
# Supervisor for the stocks server. Launch THIS inside screen instead of
# `python app.py`. It relaunches the server whenever it asks for a restart
# (exit code 42 — via SIGHUP, ./restart.sh, or POST /api/restart). Any other
# exit (Ctrl-C, crash, clean stop) ends the supervisor too.
#
#   screen -S stocks ./run.sh
#
# Env: PYTHON (default .venv/bin/python), PORT (default 8050).
set -u
cd "$(dirname "$0")"
PY="${PYTHON:-.venv/bin/python}"

while true; do
  "$PY" app.py
  code=$?
  if [ "$code" -eq 42 ]; then
    echo "[run.sh] restart requested — relaunching…"
    sleep 0.5    # let the listening socket fully release before rebinding
    continue
  fi
  echo "[run.sh] server exited (code $code) — stopping supervisor."
  break
done
