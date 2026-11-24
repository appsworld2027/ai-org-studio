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
  # Cloud Shell can answer "https://8484-None" when it does not know its own host: ignore that.
  case "$W" in *None*|"") ;; *) BASE="${W%/}" ;; esac
fi
URL="$BASE/?k=$(cat "$KEYF")"
running(){ curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/healthz"; }
WEBF="$STATE/web-url"; CFD="$STATE/tools/cloudflared"
# Web link: a free Cloudflare tunnel gives the Studio an https address that opens from any browser or phone.
# The private key still protects it. The address changes when the tunnel restarts (this script prints the new one).
web_up(){ [ -s "$WEBF" ] && tmux has-session -t studio-web 2>/dev/null; }
start_web(){
  [ "${STUDIO_WEB:-1}" = 0 ] && return 0
  if [ ! -x "$CFD" ]; then
    mkdir -p "$STATE/tools"; A=$(uname -m); case "$A" in x86_64) A=amd64 ;; aarch64|arm64) A=arm64 ;; esac
    curl -fsSL -m 120 -o "$CFD.part" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A" && chmod +x "$CFD.part" && mv "$CFD.part" "$CFD" || { rm -f "$CFD.part"; echo "  (web link: could not download Cloudflare's tunnel program; use the link below)"; return 0; }
  fi
  tmux kill-session -t studio-web 2>/dev/null; rm -f "$WEBF" "$STATE/web.log"
  # http2 (not QUIC/UDP): works on networks that block UDP. Restarts itself if it drops.
  tmux new-session -d -s studio-web "while true; do '$CFD' tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:$PORT >> '$STATE/web.log' 2>&1; sleep 5; done"
  # Wait until the tunnel is registered with Cloudflare (the address alone is not enough yet).
  for _ in $(seq 1 60); do U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/web.log" 2>/dev/null | tail -1); [ -n "$U" ] && grep -q "Registered tunnel connection" "$STATE/web.log" && break; sleep 0.5; done
  if [ -n "${U:-}" ] && grep -q "Registered tunnel connection" "$STATE/web.log"; then echo "$U" > "$WEBF"; chmod 600 "$WEBF"
  else echo "  (web link: Cloudflare did not accept the tunnel yet; it keeps retrying in the background. Later run: bash $DIR/bin/studio.sh link)"; fi
}
case "${1:-start}" in
  stop) tmux kill-session -t studio 2>/dev/null; tmux kill-session -t studio-web 2>/dev/null; rm -f "$WEBF"; pkill -f "node $DIR/server/server.mjs" 2>/dev/null; echo "Studio stopped."; exit 0 ;;
  web) start_web; [ -s "$WEBF" ] && echo "$(cat "$WEBF")/?k=$(cat "$KEYF")"; exit 0 ;;
  restart) bash "$0" stop >/dev/null; sleep 1 ;;
  link) U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/web.log" 2>/dev/null | tail -1)
    if [ -n "$U" ] && tmux has-session -t studio-web 2>/dev/null && [ "$(grep -n "$U" "$STATE/web.log" | tail -1 | cut -d: -f1)" -lt "$(grep -n "Registered tunnel connection" "$STATE/web.log" | tail -1 | cut -d: -f1 || echo 0)" ]; then echo "$U" > "$WEBF"; fi
    [ -s "$WEBF" ] && echo "$(cat "$WEBF")/?k=$(cat "$KEYF")" || echo "$URL"; exit 0 ;;
esac
if ! running; then
  if ! node -e "require('$DIR/node_modules/node-pty')" 2>/dev/null; then
    echo "Installing the Studio (one time)…"
    (cd "$DIR" && npm ci --no-audit --no-fund --loglevel=error --ignore-scripts=false) || { echo "STOP: install failed"; exit 1; }
  fi
  gh auth status >/dev/null 2>&1 || echo "Note: the GitHub CLI is not signed in, so the Agents tab and Add product cannot work yet. Run: gh auth login"
  # Pass the machine's link settings to the background server (background shells may not inherit them).
  ENVS="STUDIO_TOKEN='$(cat "$KEYF")' STUDIO_PORT='$PORT'"
  for v in WEB_HOST CLOUD_SHELL DEVSHELL_PROJECT_ID CODESPACE_NAME GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN GITPOD_WORKSPACE_URL STUDIO_PUBLIC_URL STUDIO_ALLOW_HOST STUDIO_HOME STUDIO_WORKSPACE STUDIO_GARAGE STUDIO_GARAGE_REPO; do
    [ -n "${!v:-}" ] && ENVS="$ENVS $v='${!v}'"
  done
  CMD="cd '$DIR' && env $ENVS node server/server.mjs >> '$STATE/studio.log' 2>&1"
  if command -v tmux >/dev/null; then tmux new-session -d -s studio "$CMD"; else setsid nohup bash -c "$CMD" >/dev/null 2>&1 < /dev/null & disown; fi
  for _ in $(seq 1 30); do running && break; sleep 0.5; done
  running || { echo "STOP: the Studio did not start. Last log lines:"; tail -20 "$STATE/studio.log"; exit 1; }
fi
web_up || start_web
# Codespaces: forwarded ports are private to your GitHub account by default; make sure this one is forwarded.
if [ -n "${CODESPACE_NAME:-}" ] && command -v gh >/dev/null; then gh codespace ports visibility "$PORT:private" -c "$CODESPACE_NAME" >/dev/null 2>&1 || true; fi
echo
echo "  AI Org Studio is running ($WHERE, port $PORT)."
if [ -s "$WEBF" ]; then
  echo "  Your private WEB link (opens from any laptop or phone; don't share it):"
  echo "  $(cat "$WEBF")/?k=$(cat "$KEYF")"
  echo "  (A new link can take up to a minute to start working. It changes if the Studio or Cloud Shell restarts; run: bash $DIR/bin/studio.sh link)"
  echo "  Inside Cloud Shell you can also use:"
fi
echo "  Your private link (Ctrl+click; don't share it):"
echo "  $URL"
case "$WHERE" in
  "Google Cloud Shell")
    if [ "${BASE#http://localhost}" != "$BASE" ]; then
      echo "  (The localhost link above only works inside Cloud Shell.)"
      echo "  Cloud Shell did not tell us this machine's web address, so open it once through Web Preview:"
      echo "    1. Click the Web Preview button (eye icon, top right of Cloud Shell) → Change port → type $PORT → Change and Preview."
      echo "    2. In the new tab, add  ?k=$(cat "$KEYF")  to the end of the address and press Enter."
      echo "  After that the Studio remembers its address and prints the full link here next time."
    else echo "  If the link does not open: Web Preview button (top right) → Change port → $PORT, then add ?k=$(cat "$KEYF") to the address once."; fi ;;
  "GitHub Codespaces") echo "  If the link does not open: Ports tab → port $PORT → Open in browser, then add ?k=$(cat "$KEYF") to the address once." ;;
  *) echo "  On a remote machine, open it through an SSH tunnel: ssh -L $PORT:localhost:$PORT <machine>, then use the link above." ;;
esac
echo "  It keeps running while this machine is on. Stop: bash $DIR/bin/studio.sh stop"
