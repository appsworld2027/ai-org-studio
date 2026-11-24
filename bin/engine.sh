#!/usr/bin/env bash
# Starts Claude Code or Codex inside the Studio's left panel. Usage: engine.sh claude|codex
# ("Other models" do not use this script; the Studio talks to them directly, see server/agent.mjs.)
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
    # Skip only the first-run colour-theme picker (the Studio's panel is dark). Sign-in and the folder-trust
    # question stay exactly as Claude Code shows them: those are the user's decisions.
    node -e '
const f=require("os").homedir()+"/.claude.json",fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
if(!c.theme||!c.hasCompletedOnboarding){c.theme=c.theme||"dark";c.hasCompletedOnboarding=true;fs.writeFileSync(f,JSON.stringify(c,null,2),{mode:0o600})}' 2>/dev/null
    dim "Claude Code · $(claude --version 2>/dev/null) · ${STUDIO_PRODUCT:-product} · signed in with your own Claude account"
    ARGS=(--append-system-prompt "$RULES"); [ "$MODE" = continue ] && ARGS+=(--continue)
    [ -n "${STUDIO_MODEL:-}" ] && ARGS+=(--model "$STUDIO_MODEL")
    [ -n "${STUDIO_EFFORT:-}" ] && ARGS+=(--effort "$STUDIO_EFFORT")
    [ -n "${STUDIO_MODEL:-}${STUDIO_EFFORT:-}" ] && dim "Model: ${STUDIO_MODEL:-default} · thinking effort: ${STUDIO_EFFORT:-default}"
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
    CX=(-c "developer_instructions=$TOML_RULES")
    [ -n "${STUDIO_MODEL:-}" ] && CX+=(-m "$STUDIO_MODEL")
    [ -n "${STUDIO_EFFORT:-}" ] && CX+=(-c "model_reasoning_effort=\"$STUDIO_EFFORT\"")
    [ -n "${STUDIO_MODEL:-}${STUDIO_EFFORT:-}" ] && dim "Model: ${STUDIO_MODEL:-default} · thinking effort: ${STUDIO_EFFORT:-default}"
    if [ "$MODE" = continue ]; then exec codex resume --last "${CX[@]}"; fi
    exec codex "${CX[@]}" ;;
  *) echo "unknown engine $ENGINE"; exit 2 ;;
esac
