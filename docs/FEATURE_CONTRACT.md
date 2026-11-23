# Feature Contract: AI Org Product Studio (v1)

Status: draft, for founder approval
Mockup: `studio-mockup.html` (clickable; not the real build)
Repo: `appsworld2027/ai-org-studio` (new, private). The AI Org repo stays the rulebook; the Studio is the app that sits on top of it.

## Why this exists
Today the founder works in three places: an AI chat, GitHub (which he should never need), and a browser tab with the app. The Studio puts the two that matter side by side: talk to the AI on the left, see the real product or the agents on the right.

## How it works, in one line
Browser → Studio web page → Studio server in your Cloud Shell → the real Claude Code / Codex / free-engine program in a terminal it controls, plus GitHub and Vercel reads → back to the page.

## Rules the design must keep
1. **Use the official programs, unmodified.** The left panel runs the real `claude` and `codex` programs. You sign in on their own sign-in screens with your own plans. The Studio never sees, stores or forwards your passwords or tokens. This follows Anthropic's rule for third-party apps and OpenAI's supported Codex clients.
2. **Private by default.** The server listens only inside Cloud Shell and is opened through Cloud Shell Web Preview, which only your Google account can reach. It is never deployed to Vercel or the public internet, because it can run commands as you.
3. **Same rules as the AI Org.** Every engine starts with the AI Org `AGENTS.md` loaded, so replies are plain language with options and one Recommended choice.
4. **No new founder chores.** The founder never opens GitHub, a terminal or a dashboard to use it.

## In scope (v1)
- Left: chat panel with an engine switch (Claude Code, Codex, free engine), each running the real program with its own sign-in and its own tools and MCP connections.
- Right, tab "Real app": the product's Vercel production link. When a Demo Pack is ready, it switches to that feature's preview link.
- Right, tab "Prototype": the product's HTML prototype from the repo. It is the default when the product has no Vercel deployment yet.
- Right, tab "Agents": live view of which agent is working on which feature and stage, read from GitHub every 30 seconds.
- Top bar: product, current feature and its stage.

## Out of scope (v1)
- Chat bubbles drawn by the Studio itself (v2; see Decisions).
- Code editor, file tree, diff viewer. It must stay a chat, not a Cursor or VS Code.
- More than one product, more than one user, mobile layout.
- Approve or Change buttons inside the Studio (v2; v1 decisions go through the chat as today).

## Acceptance criteria
| ID | Given | When | Then |
|---|---|---|---|
| ST-01 | Studio started in Cloud Shell | Founder opens the Web Preview link | Chat on the left, three tabs on the right, product name in the top bar |
| ST-02 | Claude Code not signed in | Founder picks Claude Code | Claude Code's own sign-in steps appear in the left panel; after signing in, a chat prompt is ready |
| ST-03 | Codex not signed in | Founder picks Codex | Codex's own device-code sign-in appears in the left panel |
| ST-04 | Free engine configured | Founder picks Free engine | Chat starts on the free model, no sign-in needed |
| ST-05 | Any engine | Founder types "what are the agents doing?" | The engine answers using the AI Org rules, in plain language |
| ST-06 | Founder signed in once | Cloud Shell restarts and Studio is reopened | Founder is still signed in to Claude Code and Codex |
| ST-07 | Product has a Vercel production URL | Founder opens "Real app" | The live app loads inside the panel; an "Open in new tab" link is always shown |
| ST-08 | A Demo Pack is posted with a preview link | Within 60 seconds | "Real app" switches to the preview link and labels it "Preview: <feature>" |
| ST-09 | Product has no Vercel deployment | Founder opens the Studio | "Prototype" is the default tab and shows the HTML prototype |
| ST-10 | An agent run is in progress | Founder opens "Agents" | The agent's name, feature and stage show as "working", updated within 30 seconds |
| ST-11 | Nothing is in progress | Founder opens "Agents" | "No agents working" and the next backlog item |
| ST-12 | GitHub cannot be reached | Founder opens "Agents" | "Agent status could not load. Last updated <time>." The rest of the Studio keeps working |
| ST-13 | Someone other than the founder | Opens the Web Preview link | Google blocks them; the Studio never answers on a public address |
| ST-14 | Any screen | Keyboard only | Every tab and button is reachable and has a visible focus ring |

## How the founder will test it (3 steps)
1. Run the start command I give you in Cloud Shell, then open Web Preview.
2. Pick Claude Code, sign in, ask "what's next on the backlog?".
3. Switch the right panel between Real app, Prototype and Agents.

## Phases
1. **v1 (this contract):** the Studio above, built and tested by me in iteration scripts, then run by you.
2. **v2:** decision cards with Approve and Change buttons, Demo Pack auto-switch polish, the Studio onboarded as an AI Org product so the loop can improve it.
3. **v3:** Studio-drawn chat bubbles (Codex through its official app-server protocol; Claude through an API key), a product switcher, and access for Manu.
