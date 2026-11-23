#!/usr/bin/env bash
# Start the AI Org Studio and print your private link. Works in Google Cloud Shell, GitHub Codespaces, or any Linux machine.
#   bash ~/ai-org-studio/bin/studio.sh          start (or show the link if already running)
#   bash ~/ai-org-studio/bin/studio.sh stop     stop it
#   bash ~/ai-org-studio/bin/studio.sh restart  restart it (after an update)
#   bash ~/ai-org-studio/bin/studio.sh link     just print the link
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${STUDIO_HOME:-$HOME/.ai-org-studio}"; mkdir -p "$STATE"; chmod 700 "$STATE"
PORT="${STUDIO_PORT:-$(node -e "try{console.log(require('$DIR/studio.config.json').port||8484)}catch{console.log(8484)}")}"
KEYF="$STATE/key"; [ -s "$KEYF" ] || (umask 077; head -c 18 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$KEYF")
[ "$(wc -c < "$KEYF")" -ge 20 ] || { rm -f "$KEYF"; echo "STOP: could not create the private key (is the disk full? df -h ~)"; exit 1; }
BASEURL="$(cd "$DIR" && STUDIO_PORT="$PORT" node -e "import('./server/platform.mjs').then(m=>console.log(m.publicUrl(process.env.STUDIO_PORT)+'|'+m.platform().name))")"
BASE="${BASEURL%%|*}"; WHERE="${BASEURL##*|}"
# Cloud Shell without WEB_HOST: ask Cloud Shell for the preview address of this port.
if [ "$BASE" = "http://localhost:$PORT" ] && command -v cloudshell >/dev/null 2>&1; then
  W="$(cloudshell get-web-preview-url -p "$PORT" 2>/dev/null | grep -Eo 'https://[^[:space:]]+' | head -1)"
  [ -n "$W" ] && BASE="${W%/}"
fi
URL="$BASE/?k=$(cat "$KEYF")"
running(){ curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/healthz"; }
case "${1:-start}" in
  stop) tmux kill-session -t studio 2>/dev/null; pkill -f "node $DIR/server/server.mjs" 2>/dev/null; echo "Studio stopped."; exit 0 ;;
  restart) bash "$0" stop >/dev/null; sleep 1 ;;
  link) echo "$URL"; exit 0 ;;
esac
if ! running; then
  if ! node -e "require('$DIR/node_modules/node-pty')" 2>/dev/null; then
    echo "Installing the Studio (one time)…"
    (cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error --ignore-scripts=false) || { echo "STOP: install failed"; exit 1; }
  fi
  gh auth status >/dev/null 2>&1 || echo "Note: the GitHub CLI is not signed in, so the Agents tab and Add product cannot work yet. Run: gh auth login"
  # Pass the machine's link settings to the background server (background shells may not inherit them).
  ENVS="STUDIO_TOKEN='$(cat "$KEYF")' STUDIO_PORT='$PORT'"
  for v in WEB_HOST CLOUD_SHELL DEVSHELL_PROJECT_ID CODESPACE_NAME GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN GITPOD_WORKSPACE_URL STUDIO_PUBLIC_URL STUDIO_ALLOW_HOST STUDIO_HOME STUDIO_WORKSPACE; do
    [ -n "${!v:-}" ] && ENVS="$ENVS $v='${!v}'"
  done
  CMD="cd '$DIR' && env $ENVS node server/server.mjs >> '$STATE/studio.log' 2>&1"
  if command -v tmux >/dev/null; then tmux new-session -d -s studio "$CMD"; else setsid nohup bash -c "$CMD" >/dev/null 2>&1 < /dev/null & disown; fi
  for _ in $(seq 1 30); do running && break; sleep 0.5; done
  running || { echo "STOP: the Studio did not start. Last log lines:"; tail -20 "$STATE/studio.log"; exit 1; }
fi
# Codespaces: forwarded ports are private to your GitHub account by default; make sure this one is forwarded.
if [ -n "${CODESPACE_NAME:-}" ] && command -v gh >/dev/null; then gh codespace ports visibility "$PORT:private" -c "$CODESPACE_NAME" >/dev/null 2>&1 || true; fi
echo
echo "  AI Org Studio is running ($WHERE, port $PORT)."
echo "  Your private link (Ctrl+click; don't share it):"
echo "  $URL"
case "$WHERE" in
  "Google Cloud Shell")
    if [ "${BASE#http://localhost}" != "$BASE" ]; then
      echo "  Cloud Shell did not tell us this machine's web address, so open it once through Web Preview:"
      echo "    1. Click the Web Preview button (eye icon, top right of Cloud Shell) → Change port → type $PORT → Change and Preview."
      echo "    2. In the new tab, add  ?k=$(cat "$KEYF")  to the end of the address and press Enter."
      echo "  After that the Studio remembers its address and prints the full link here next time."
    else echo "  If the link does not open: Web Preview button (top right) → Change port → $PORT, then add ?k=$(cat "$KEYF") to the address once."; fi ;;
  "GitHub Codespaces") echo "  If the link does not open: Ports tab → port $PORT → Open in browser, then add ?k=$(cat "$KEYF") to the address once." ;;
  *) echo "  On a remote machine, open it through an SSH tunnel: ssh -L $PORT:localhost:$PORT <machine>, then use the link above." ;;
esac
echo "  It keeps running while this machine is on. Stop: bash $DIR/bin/studio.sh stop"
