# AI Org Studio

A chat-first product studio for founders and AI PMs. You describe what you want; AI does the product, design, engineering and testing work; you approve the plan and test the result. There is no code editor; there doesn't need to be one.

- **Left: talk to the AI.** Pick one:
  - **Claude Code**: Anthropic's own program, with your Claude plan.
  - **Codex**: OpenAI's own program, with your ChatGPT plan.
  - **Other models**: a chat the Studio draws itself, on free models with your own free-tier key. Supported free providers: Groq, NVIDIA evaluation, OpenRouter :free models, Google Gemini free tier or Ollama on your machine. The unattended AI Org agents use only the allowlisted Groq free-tier models. It reads the product freely and asks before it changes a file or runs a command.
- **Right: see the product.**
  - **Real app**: its live link, for example on Vercel. It switches automatically to a feature's preview when that feature is ready to test.
  - **Prototype**: the HTML mockups in the repo, used until a real app exists.
  - **Agents**: which AI agent is working on which feature, at which stage, live from GitHub.
- **Any product.** Add any GitHub repository with *Add product* and switch between them at the top.
- **Real chat for Claude Code and Codex**, like their VS Code extensions:
  - streamed replies, with a live "what it's doing" line;
  - step cards for files read and changed and commands run, with the changes;
  - Allow / Don't allow cards, and clickable questions;
  - attachments with the button, Ctrl+V or drag-and-drop;
  - a model and thinking picker.

  It runs on your own Claude / ChatGPT plan (personal use; see `docs/COMPLIANCE.md`). Engineers can still open "Terminal view".
- **Pick the brain.** Choose model and thinking level under the text box (Other models), or above the Claude Code / Codex screen. Decisions come as clickable cards with one Recommended option.
- **Team.** Agents → Team shows local model recommendations and advisory availability. The GitHub Actions workers follow the authoritative AI Org autonomy policy, not Studio overrides. Local selections do not change a worker's assigned model, provider credentials or qualification status.

It runs on your own free cloud machine, and only you can open it: the link carries a private key, and the machine's own sign-in protects it too.

## Run it

**Google Cloud Shell** (free, about 50 h a week):
```bash
git clone https://github.com/appsworld2027/ai-org-studio.git ~/ai-org-studio
bash ~/ai-org-studio/bin/studio.sh
```
Ctrl+click the printed link.

**GitHub Codespaces** (free, 60 h a month on 2 cores):
On the repository page, choose **Code → Codespaces → Create codespace**. The Studio installs and starts by itself. The printed link (also listed in the Ports tab, port 8484) opens it. The port stays private to your GitHub account.

**Any Linux machine with Node 18+, git and the GitHub CLI:** the same two commands as Cloud Shell. Open the link through an SSH tunnel: `ssh -L 8484:localhost:8484 <machine>`.

You need the GitHub CLI signed in (`gh auth login`) for *Add product* and the Agents tab.

```bash
bash ~/ai-org-studio/bin/studio.sh link     # print the link again
bash ~/ai-org-studio/bin/studio.sh restart  # after an update
bash ~/ai-org-studio/bin/studio.sh stop
bash ~/ai-org-studio/bin/studio.sh web      # start a new web link (any browser, any phone)
```

### Web link and always-on

`studio.sh` also starts a free Cloudflare tunnel and prints a **web link** (`https://…trycloudflare.com/?k=…`) that opens from any laptop or phone. The chat reconnects by itself if the connection drops, and Claude Code / Codex keep working on the server while you are away.

Limits on Cloud Shell: the machine sleeps after ~40 minutes without you in the Cloud Shell tab, and every session ends after 12 hours; then the Studio and the link stop until you open Cloud Shell again. Chats, memory (Garage) and connected apps are kept.

**Always-on (recommended for daily use):** run the Studio on a small always-on Linux machine (e.g. a Google Compute Engine e2-small, about US$13–15 a month; or any VPS). Same two commands. For a fixed address, use a named Cloudflare tunnel with your own domain instead of the quick tunnel.

**Why not Vercel:** Vercel runs short-lived functions (connections end after 5–30 minutes, no lasting disk), which cannot keep Claude Code / Codex sessions, your logins and product folders alive. Vercel stays the place where the *products* are deployed and tested.

## How it works

Browser → Studio page → Studio server (Node, on your machine). Then, depending on what you picked:

- **Claude Code / Codex:** `bin/engine.sh` runs the official program in a terminal, and the page shows it with xterm.js. You sign in on the program's own screen. The Studio never sees your password or tokens; that is the only way Anthropic and OpenAI allow a plan login in a third-party tool.
- **Other models:** `server/agent.mjs` runs a tool-using loop against the model's OpenAI-compatible API, with your key. Its tools are: list, read and search files (no approval needed); write, edit and run commands (asks first). It is locked to the product's folder.
- **Agents tab:** `gh api` with your GitHub login, turned into the board by `server/status.mjs`.

Every AI gets the same working rules (`studio-rules.md`) plus the product's own `AGENTS.md` / `CLAUDE.md`. Those rules are: plain language, options with one Recommended choice, build-test-show without stopping halfway, never merge to main.

Your data stays in `~/.ai-org-studio` and is never put in the repo:

- `products.json`: your products;
- `keys.json`: your model keys, readable by you only;
- `chats/`: your conversations;
- `key`: the Studio's private key.

Product copies live in `~/studio-products/`.

## Files

| Path | What it is |
|---|---|
| `server/server.mjs` | Web server: private-key check, products, terminals, chat, GitHub reads |
| `server/agent.mjs` | The Other-models agent: tools, approval rules, streaming loop |
| `server/providers.mjs` | Supported model providers |
| `server/store.mjs` | Products, keys and chats in `~/.ai-org-studio` |
| `server/platform.mjs` | Cloud Shell / Codespaces / other: the right link |
| `server/team.mjs` | Agent → model matching from each agent's job |
| `server/uploads.mjs` | Attachments for the chat |
| `server/engines/` | Claude Code (stream-json) and Codex (app-server) chat engines, plain-language step labels |
| `server/engine-chats.mjs` | One running program per conversation, saved transcripts |
| `public/echat.js` | The Claude Code / Codex chat view |
| `server/status.mjs` | Agents board logic |
| `public/` | The page |
| `bin/engine.sh` | Starts Claude Code / Codex, installing them once |
| `bin/studio.sh` | Start, stop, restart, link |
| `.devcontainer/` | GitHub Codespaces setup |
| `test/`, `e2e/` | Unit tests (`npm test`) and the full browser test (`node e2e/studio.e2e.mjs`) |

## Checks

CI runs the Node unit suite, shell syntax checks and full Playwright browser journeys against isolated stand-in engines. It does not install subscription CLIs, require account sign-in or call paid inference APIs.

## Free-model-only agent policy
The Studio's model API agent blocks OpenAI API, Anthropic API and custom paid servers permanently. OpenRouter is limited to `:free` models, and Groq is restricted to the explicit free-tier model allowlist in `server/billing.mjs`. No environment variable can enable paid API providers.

The unattended AI Org worker uses Groq GPT-OSS 120B for building and Qwen 3.8 27B for independent review. Keep the Groq account on its free tier; the application cannot control account upgrades or provider billing settings.

The Claude Code and Codex tabs are separate interactive founder tools using the user's own plan sign-in. They are not execution engines for unattended AI Org agents.
