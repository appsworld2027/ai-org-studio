#!/usr/bin/env bash
# Start the AI Org Studio in Cloud Shell and print the private link.
#   bash ~/ai-org-studio/bin/studio.sh          start (or show the link if already running)
#   bash ~/ai-org-studio/bin/studio.sh stop     stop it
#   bash ~/ai-org-studio/bin/studio.sh restart  restart it (after an update)
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"; STATE="$HOME/.ai-org-studio"; mkdir -p "$STATE"; chmod 700 "$STATE"
PORT="$(node -e "console.log(require('$DIR/studio.config.json').port||8080)")"
KEYF="$STATE/key"; [ -s "$KEYF" ] || (umask 077; head -c 18 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$KEYF")
URL(){ if [ -n "${WEB_HOST:-}" ]; then echo "https://$PORT-$WEB_HOST/?k=$(cat "$KEYF")"; else echo "http://localhost:$PORT/?k=$(cat "$KEYF")"; fi; }
running(){ curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/healthz"; }
case "${1:-start}" in
  stop) tmux kill-session -t studio 2>/dev/null; pkill -f "node $DIR/server/server.mjs" 2>/dev/null; echo "Studio stopped."; exit 0 ;;
  restart) bash "$0" stop >/dev/null; sleep 1 ;;
esac
if ! running; then
  [ -d "$DIR/node_modules/node-pty" ] || { echo "Installing the Studio (one time)…"; (cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error --ignore-scripts=false) || { echo "STOP: install failed"; exit 1; }; }
  gh auth status >/dev/null 2>&1 || echo "Note: gh is not signed in, so the Agents tab cannot load. Run: gh auth login"
  CMD="cd '$DIR' && STUDIO_TOKEN='$(cat "$KEYF")' WEB_HOST='${WEB_HOST:-}' node server/server.mjs >> '$STATE/studio.log' 2>&1"
  if command -v tmux >/dev/null; then tmux new-session -d -s studio "$CMD"; else setsid nohup bash -c "$CMD" >/dev/null 2>&1 < /dev/null & disown; fi
  for _ in $(seq 1 30); do running && break; sleep 0.5; done
  running || { echo "STOP: the Studio did not start. Last log lines:"; tail -20 "$STATE/studio.log"; exit 1; }
fi
echo
echo "  AI Org Studio is running on port $PORT."
echo "  Open your private link (Ctrl+click):"
echo "  $(URL)"
echo
echo "  Or: Web Preview button (top right of Cloud Shell) → Change port → $PORT, then add ?k=<key> once."
echo "  It keeps running while Cloud Shell is open. Stop: bash $DIR/bin/studio.sh stop"
