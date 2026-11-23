#!/usr/bin/env bash
# Starts one AI engine inside the Studio's left panel. Usage: engine.sh claude|codex|free
# Uses the official, unmodified programs. Sign-in happens on their own screens; the Studio never sees credentials.
set -uo pipefail
ENGINE="${1:?engine}"; MODE="${STUDIO_MODE:-new}"
STUDIO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$HOME/.ai-org-studio/tools"; export PATH="$TOOLS/node_modules/.bin:$HOME/.local/bin:$PATH"
RULES="$(cat "${STUDIO_RULES:-$STUDIO_DIR/studio-rules.md}" 2>/dev/null)"
dim(){ printf '\033[90m%s\033[0m\n' "$*"; }
say(){ printf '\033[1m%s\033[0m\n' "$*"; }
# The tools folder is a tiny npm project whose package.json approves the engines' install steps
# (npm 11.20+, shipped with Node 26, blocks unapproved install scripts; older npm ignores the field).
tools_pkg(){ mkdir -p "$TOOLS"; node -e '
const f=process.argv[1]+"/package.json",fs=require("fs");let p={};try{p=JSON.parse(fs.readFileSync(f))}catch{}
p.name="ai-org-studio-tools";p.private=true;p.allowScripts={...(p.allowScripts||{}),"@anthropic-ai/claude-code":true,"@openai/codex":true};
fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$TOOLS"; }
need(){ # need <command> <npm package>: installs into ~/.ai-org-studio/tools (survives Cloud Shell restarts)
  command -v "$1" >/dev/null 2>&1 && return 0
  say "Installing $1 (one time, about a minute)…"
  tools_pkg
  (cd "$TOOLS" && npm install --no-audit --no-fund --loglevel=error --ignore-scripts=false "$2" >/dev/null) || { say "Could not install $2. Check the internet connection, then press Restart."; exit 1; }
}

case "$ENGINE" in
  claude)
    need claude @anthropic-ai/claude-code
    dim "Claude Code · $(claude --version 2>/dev/null) · ${STUDIO_PRODUCT:-product} · signed in with your own Claude account"
    ARGS=(--append-system-prompt "$RULES"); [ "$MODE" = continue ] && ARGS+=(--continue)
    exec claude "${ARGS[@]}" ;;
  codex)
    need codex @openai/codex
    if ! codex login status >/dev/null 2>&1; then
      say "Sign in to Codex with your ChatGPT account."
      dim "Open the link below in a new browser tab and enter the code. (If it says device codes are off: ChatGPT → Settings → Security → turn on device code sign-in.)"
      codex login --device-auth || { say "Sign-in did not finish. Press Restart to try again."; exit 1; }
    fi
    dim "Codex · $(codex --version 2>/dev/null) · ${STUDIO_PRODUCT:-product} · signed in with your own ChatGPT account"
    # A JSON string is also a valid TOML string, so this passes the rules safely whatever characters they contain.
    TOML_RULES=$(printf '%s' "$RULES" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')
    if [ "$MODE" = continue ]; then exec codex resume --last -c "developer_instructions=$TOML_RULES"; fi
    exec codex -c "developer_instructions=$TOML_RULES" ;;
  free)
    need claude @anthropic-ai/claude-code
    ENV="$HOME/.fcc/.env"
    if ! grep -q '^NVIDIA_NIM_API_KEY=.\+' "$ENV" 2>/dev/null; then
      say "The free engine needs your NVIDIA key once (free at build.nvidia.com → API keys)."
      dim "Type it here; it is saved only in your Cloud Shell ($ENV), never shown and never sent to the chat."
      read -r -s -p "NVIDIA key: " KEY; echo
      [ -n "$KEY" ] || { say "No key entered. Press Restart to try again."; exit 1; }
      mkdir -p "$HOME/.fcc" && umask 077 && printf 'NVIDIA_NIM_API_KEY=%s\nMODEL=%s\nHTTP_READ_TIMEOUT=600\nFCC_OPEN_BROWSER=false\n' "$KEY" "${STUDIO_FREE_MODEL:-nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b}" > "$ENV"
      unset KEY
    fi
    if ! curl -s -o /dev/null http://127.0.0.1:8082/v1/models; then
      if ! command -v fcc-server >/dev/null 2>&1; then
        say "Installing the free-engine bridge (one time)…"
        command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
        uv tool install free-claude-code >/dev/null 2>&1 || { say "Could not install the free-engine bridge. Press Restart to try again."; exit 1; }
      fi
      mkdir -p "$HOME/.ai-org-studio"; nohup fcc-server > "$HOME/.ai-org-studio/fcc.log" 2>&1 &
      for _ in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:8082/v1/models && break; sleep 1; done
    fi
    MODEL=$(sed -n 's/^MODEL=//p' "$ENV" | head -1)
    dim "Free engine · Claude Code program on ${MODEL:-the free model} via NVIDIA (not a Claude model) · ${STUDIO_PRODUCT:-product}"
    ARGS=(--append-system-prompt "$RULES
You are running on ${MODEL:-a free NVIDIA model}, not a Claude model. Say so if asked."); [ "$MODE" = continue ] && ARGS+=(--continue)
    ANTHROPIC_BASE_URL=http://127.0.0.1:8082 ANTHROPIC_AUTH_TOKEN=freecc API_TIMEOUT_MS=600000 DISABLE_AUTOUPDATER=1 exec claude "${ARGS[@]}" ;;
  *) echo "unknown engine $ENGINE"; exit 2 ;;
esac
