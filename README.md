# AI Org Studio

The founder's screen for building products with the AppsWorld AI Org.

- **Left:** the AI chat. Pick Claude Code, Codex or the free engine. These are the real, unmodified programs in a browser terminal. You sign in on their own screens with your own plans; the Studio never sees passwords or tokens.
- **Right, tabs:** **Real app** (the Vercel link, switching to a feature's preview when its Demo Pack is ready), **Prototype** (the HTML designs, shown by default when there is no Vercel yet) and **Agents** (which agent is working on which feature and stage, live from GitHub every 30 seconds).

It runs in your own Cloud Shell and opens through Web Preview, so only your Google account can reach it. On top of that, it needs a private key, carried in the start link. Never deploy it to a public address: it can run commands as you.

## Start

```bash
bash ~/ai-org-studio/bin/studio.sh          # start, or print the link if already running
bash ~/ai-org-studio/bin/studio.sh restart  # after an update
bash ~/ai-org-studio/bin/studio.sh stop
```

Ctrl+click the printed link. Cloud Shell sleeps after about 40 idle minutes; run the start command again when you come back.

## How it works

Browser → Studio page → Studio server (Node, in Cloud Shell) → `bin/engine.sh` starts `claude`, `codex` or the free engine in a pseudo-terminal → the page shows it with xterm.js.
The Agents tab: Studio server → `gh api` with your GitHub login → `server/status.mjs` turns labels, runs and comments into the board.

Every engine starts with `studio-rules.md` added to its instructions, plus the product's own `AGENTS.md` / `CLAUDE.md`. So it answers in plain language with one Recommended option, and posts your decisions to the AI Org for you.

## Files

| Path | What it is |
|---|---|
| `server/server.mjs` | Web server, private-key check, terminal bridge, GitHub reads |
| `server/status.mjs` | Pure logic for the Agents board (unit-tested) |
| `public/` | The page: `index.html`, `styles.css`, `app.js` |
| `bin/engine.sh` | Starts each engine, installing it once under `~/.ai-org-studio/tools` |
| `bin/studio.sh` | Start, stop and restart; prints the private link |
| `studio.config.json` | Product name, repo, Vercel URL, prototypes, port |
| `studio-rules.md` | Rules added to every engine's instructions |
| `test/` | Unit tests (`npm test`) |
| `e2e/` | Browser test of the whole Studio with stand-in GitHub and engines |

## Checks

`npm test` (logic) and `node e2e/studio.e2e.mjs` (browser) cover the Feature Contract checks ST-01 to ST-14. CI runs both on every pull request.
