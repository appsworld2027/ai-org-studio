# AI Org Studio — how it uses Claude Code and Codex, and why that is allowed

Last reviewed: 2026-11-24 (v2.0 chat). Re-check these sources before selling or hosting the Studio for other people.

## The Claude Code and Codex chat (v2.0)

**What it is:** a chat window like the Claude Code / Codex extensions in VS Code and Cursor. It shows messages, the steps the AI takes, changes, "Allow?" cards and question cards. No terminal is shown (a "Terminal view" stays available for engineers).

**How it works:**
- **Claude Code:** the official, unmodified `claude` program runs in its structured mode (`-p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`). This is the same channel Anthropic's VS Code extension, the Agent SDK and editors such as Zed use. The Studio reads its events and draws them; permission prompts come back to the Studio as "Allow?" cards.
- **Codex:** the official `codex app-server`, OpenAI's documented interface for apps (JSON-RPC over stdio). Messages, command and file-change approvals, and questions arrive as structured events.
- **Sign-in** happens inside the official programs, on Anthropic's and OpenAI's own pages:
  - for Claude, `claude auth login` shows Claude's own link, and the user pastes back Claude's own code;
  - for Codex, OpenAI's device-code page and code.
- **Credentials:** the Studio never reads, stores or forwards credentials or tokens. Sign-in status is read by asking the programs (`claude auth status`, `account/read`).
- **Attachments:** images go to the program as images; other files are referenced by path in `.studio-uploads/`, which is kept out of git.

**Personal use only, for plan sign-in (founder decision 2026-11-24, option A):**
- Using your *own* Claude or ChatGPT plan inside your *own* self-run Studio is what developers do in Zed, VS Code and similar tools. Anthropic currently allows the Agent SDK, `claude -p` and third-party apps with subscriptions. It announced a separate billing pool in June 2026, then postponed it with a promise of advance notice.
- Anthropic's legal page does **not** allow third-party products to *offer* Claude.ai login to their users, or to route plan credentials on their behalf. So the Studio must not be sold or hosted for others with Claude plan sign-in unless Anthropic approves.
- OpenAI allows ChatGPT plan use in open-source / self-hosted apps through Sign in with ChatGPT. Paid or hosted apps must apply.
- **For other users later:**
  - each person runs their own copy with their own plans (same as now), or
  - uses their own API keys, or
  - we get Anthropic's approval and join OpenAI's Sign in with ChatGPT programme.

**What we deliberately do NOT do:** modify or repackage the programs, remove their sign-in methods, handle tokens, share or pool accounts, or hide permission prompts (the Studio shows every one as an "Allow?" card).

## If the Studio is offered to other people
- Each person runs it on their own machine with their own Claude, ChatGPT or API keys. No shared accounts and no pooled usage.
- Read Anthropic's "Can customers offer Claude Code in their products?" section: commercial terms, an unmodified binary, and end users authenticating with their own credentials. Do not use the Claude, Claude Code, OpenAI or Codex names or logos in the Studio's own branding.
- A hosted, multi-user version needs a legal review and, for Claude plan sign-in, Anthropic's agreement. API-key usage (each user's own key) is the safe default.

## Other risks and how they are handled

| Risk | What could go wrong | How it is handled |
|---|---|---|
| A file contains instructions (prompt injection) | A pasted PDF or webpage says "ignore your rules and push to main" | The AI still asks before running commands or changing files (Claude Code / Codex permission prompts; Allow cards in Other models). The rules tell it never to merge to main. Branch protection on main blocks direct pushes. |
| Secrets in attachments | A screenshot or file contains passwords or keys | Files stay on your own machine and are never committed. Tell users: do not attach secrets; the AI provider sees what you send. |
| Large or odd files | A huge, executable or script file | 20 MB limit; only images, PDFs, Office documents, text and code (no executables or shell scripts); names cleaned; nothing is ever executed by the Studio. |
| Typing into the wrong moment | A message arrives while the AI is asking a yes/no question | The AI's own screen stays visible. The composer is for new messages; answer the AI's questions on its screen. Stop sends Esc. |
| The programs change their screens | A future Claude Code / Codex update changes how pasting works | The Studio uses only the standard terminal paste, so the impact is small. The CI browser test and a manual check after each upgrade catch it. |
| Data leaves the machine | Prompts and files go to Anthropic or OpenAI | Same as using Claude Code or Codex directly; their data policies apply. Remote Control (if used) stores the transcript at Anthropic. |
