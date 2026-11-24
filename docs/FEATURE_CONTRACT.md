# Feature Contract: AI Org Studio

Status: v2.0 approved by the founder (2026-11-24, option A: real chat for Claude Code and Codex on the founder's own plans, like the VS Code extension; terminal only behind "Terminal view")
Repo: `appsworld2027/ai-org-studio` (private). A product of its own, separate from any product built with it.

## What it is
A chat-first studio where a founder or AI PM builds professional products with AI. The founder gives requirements, approves plans and mockups, and tests the result. AI takes every other hat (product, design, engineering, QA) and loops until the result works. It is not an IDE: there is no code editor or file tree.

## Rules the design must keep
1. **Any product.** Nothing is tied to Parent Plus. Products are GitHub repos the user adds.
2. **Any AI, with the user's own login or key.**
   - Claude Code and Codex run as their own unmodified programs, with the user's own plan; the Studio never sees credentials. This is the only way their plans are allowed.
   - "Other models" use the user's own API key (free or paid), via a Studio-drawn chat.
3. **Private.** It runs on the user's own machine (Cloud Shell, Codespaces, any Linux machine). It is reachable only through that platform's private link plus a Studio key, and never through a public address.
4. **Same working rules for every AI:** plain language, options with one Recommended choice, build-test-show without stopping, never merge to main.
5. **Safe by default:** the Other-models agent reads freely, but asks before changing files or running commands, and stays inside the product folder.

## Acceptance criteria
| ID | Given | When | Then |
|---|---|---|---|
| ST-01 | Studio started | Open the link | Product picker on top; Claude Code, Codex and Other models on the left; Real app, Prototype and Agents on the right |
| ST-02 | Any product | Pick Claude Code | Claude Code's own screen for that product; first time, its own sign-in |
| ST-03 | Any product | Pick Codex | Codex's own screen; first time, its own device-code sign-in |
| ST-06 | A chat is running | Reload, or Continue last chat, or Restart | Reload re-attaches; Continue reopens the last conversation; Restart starts fresh |
| ST-07 | Product has no app link | Set app link (https only) | It loads in Real app; a bad link is refused with a reason |
| ST-08 | A Demo Pack has a preview link | Within 60 s | Real app switches to it, labelled "Preview: <feature>" |
| ST-09 | No app link | Open the product | Prototype is the default tab and shows the repo's HTML prototype; no other file can be fetched |
| ST-10 | AI Org product with work in flight | Open Agents | Who is working on which feature and stage, updated within 30 s; "what just happened" feed |
| ST-11 | Product not using the AI Org | Open Agents | A plain explanation, plus how to set it up |
| ST-12 | GitHub unreachable | Open Agents | "Could not refresh … last loaded at <time>"; the rest keeps working; recovers by itself |
| ST-13 | Anyone without the key, or another website | Open the Studio or send it requests | Refused (401 / 403); no terminal, chat or write access |
| ST-14 | Any screen | Keyboard only | Tabs reachable; visible focus |
| ST-15 | Other models | Add a provider key | Key is checked and models are listed; the key is stored owner-only and never sent back to the page |
| ST-16 | Other models chat | Ask for a change | Reply streams in; reading needs no approval; writing or running asks "Allow?" first; model output is shown as text, never run |
| ST-17 | Other models chat | Reload | The conversation is still there |
| ST-18 | Any GitHub repo the user can open | Add product | Bad input is explained; the repo is copied into the Studio's workspace and becomes selectable; engines open in it |
| ST-19 | Cloud Shell, Codespaces or other | Start the Studio | The printed link is that platform's private link (not localhost) |
| ST-20 | Other models chat | The AI needs a product decision | Clickable cards: 2–4 options, one marked Recommended, plus "type your own"; the click goes back to the AI, and the card stays answered after a reload |
| ST-21 | Other models chat | Pick a model / thinking level under the text box | The next message uses it (like Cursor); a model that refuses a thinking level continues without it and says so |
| ST-22 | Claude Code or Codex | Pick model and thinking above the screen, Apply | The program restarts with that model and effort and keeps the last conversation |
| ST-25 | Claude Code chat | Send a message with a pasted screenshot | The reply streams as text with formatting; each step appears as a short card ("Create docs/idea.md · 3 lines", ✓ when done); changing a file first shows "Allow Claude Code to change files?" with the change; a question shows clickable options with Recommended; no terminal text anywhere; the image reaches Claude |
| ST-26 | Claude Code chat | Reload the page | Same conversation; answered cards stay answered |
| ST-27 | Codex chat | Ask for something that runs a command | Same experience: step card, "Allow Codex to run this?", the command runs only after Allow, formatted reply |
| ST-28 | Claude Code / Codex | Open the chat | Shows who is signed in, or offers "Sign in to Claude / ChatGPT" through their own sign-in page and code |
| ST-23 | AI Org product | Open Agents → Team | Every agent shows which AI it uses and why; builders and their reviewers get different models when possible; a backup is named; the owner can override any row |

## Out of scope (next)
- Approve and Change buttons in the "Waiting for you" cards.
- A "Ready to test" alert.
- The Studio set up as an AI Org product itself.
- Multiple users (e.g. Manu) on one Studio.
- Hosted multi-tenant version.
