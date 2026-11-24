// Connected apps (MCP servers) for every AI in the Studio: Claude Code, Codex and the free/other-model chat.
// The user connects an app ONCE in the Studio (Apps button); every AI then gets it automatically.
//
// Key safety: keys live in ~/.ai-org-studio/connectors.json (readable by you only), are never sent to the page,
// never put in the AI's own environment (so an AI command like `env` cannot print them), and are handed only to
// the app's MCP server process through bin/mcp-run.mjs, which reads them from that file at start-up.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

// Catalog: what each app is, how to get the key (exact clicks), and how to run its official MCP server.
// `pkg` servers are started with npx from the official npm package (downloaded once, cached).
// `builtin` apps need no key: GitHub uses the gh sign-in already on this machine; Browser runs a local Chrome.
export const CATALOG = [
  { id: "github", name: "GitHub", what: "Issues, pull requests, Actions, code", builtin: "gh",
    steps: ["Nothing to do: the AI uses the GitHub sign-in already on this machine (gh). If it ever says signed out, run `gh auth login` once in Cloud Shell."] },
  { id: "browser", name: "Browser (Chrome DevTools)", what: "Open the app, click through it, read console errors and network calls, take screenshots", builtin: "chrome",
    pkg: "chrome-devtools-mcp@latest", args: ["--headless", "--isolated", "--no-usage-statistics", "--chrome-arg=--no-sandbox"], needsChrome: true,
    steps: ["Press Connect. The first time, the Studio downloads Chrome for the AI (about 150 MB, once). After that the AI opens the app in its own headless Chrome whenever it needs to check something."] },
  { id: "supabase", name: "Supabase", what: "Database tables, SQL (read-only by default), logs, edge functions",
    pkg: "@supabase/mcp-server-supabase@latest", args: ["--read-only"], argsFromKeys: { SUPABASE_PROJECT_REF: (v) => (v ? ["--project-ref", v] : []) },
    keys: [{ env: "SUPABASE_ACCESS_TOKEN", label: "Personal access token", secret: true, hint: "starts with sbp_" },
      { env: "SUPABASE_PROJECT_REF", label: "Project ref (optional — limits the AI to one project)", secret: false, hint: "e.g. zcgcnycnanqkbdlwojln (your DEV project)" }],
    steps: ["Open supabase.com/dashboard/account/tokens", "Generate new token → name it \"AI Org Studio\" → Generate", "Copy it and paste it below", "Recommended: also paste your DEV project ref so the AI cannot touch production"],
    link: "https://supabase.com/dashboard/account/tokens", safety: "Read-only mode is on: the AI can look at data and run SELECTs, never change or delete. Ask in chat if you want to allow writes for one task." },
  { id: "vercel", name: "Vercel", what: "Deployments, preview links, build logs (read-only)", local: "bin/mcp-vercel.mjs",
    keys: [{ env: "VERCEL_TOKEN", label: "Access token", secret: true, hint: "from vercel.com/account/settings/tokens" },
      { env: "VERCEL_TEAM_ID", label: "Team ID (only if the project is in a team)", secret: false, optional: true, hint: "Team → Settings → General → Team ID" }],
    steps: ["Open vercel.com/account/settings/tokens → Create Token", "Name \"AI Org Studio\", scope: your account (or the team that owns the project), expiry 90 days → Create", "Copy the token and paste it below"],
    link: "https://vercel.com/account/settings/tokens", safety: "Read-only: the AI can see deployments, preview links and build logs; it cannot deploy, delete or change settings." },
  { id: "notion", name: "Notion", what: "Read and write pages and databases you share with it",
    pkg: "@notionhq/notion-mcp-server@latest", keys: [{ env: "NOTION_TOKEN", label: "Internal integration secret", secret: true, hint: "starts with ntn_" }],
    steps: ["Open notion.so/profile/integrations → New integration → name \"AI Org Studio\" → Save", "Copy the Internal Integration Secret and paste it below", "In Notion, open each page the AI may use → ••• → Connections → add \"AI Org Studio\""],
    link: "https://www.notion.so/profile/integrations" },
  { id: "figma", name: "Figma", what: "Read designs and frames to build UI from them",
    pkg: "figma-developer-mcp@latest", args: ["--stdio"], keys: [{ env: "FIGMA_API_KEY", label: "Personal access token", secret: true, hint: "starts with figd_" }],
    steps: ["Figma → your avatar → Settings → Security → Personal access tokens → Generate new token", "Scopes: File content = Read-only", "Copy and paste below"],
    link: "https://www.figma.com/developers/api#access-tokens" },
  { id: "sentry", name: "Sentry", what: "Production errors and crash reports",
    pkg: "@sentry/mcp-server@latest", keys: [{ env: "SENTRY_ACCESS_TOKEN", label: "User auth token", secret: true, hint: "starts with sntryu_" }],
    steps: ["sentry.io → Settings → Account → API → Personal Tokens → Create New Token", "Scopes: project:read, event:read, org:read", "Copy and paste below"],
    link: "https://sentry.io/settings/account/api/auth-tokens/" },
  { id: "context7", name: "Library docs (Context7)", what: "Up-to-date documentation for any library or framework",
    pkg: "@upstash/context7-mcp@latest", keys: [{ env: "CONTEXT7_API_KEY", label: "API key (optional — higher limits)", secret: true, optional: true, hint: "starts with ctx7sk_" }],
    steps: ["Works without a key. For higher limits: context7.com/dashboard → API keys → Create → paste below"], link: "https://context7.com/dashboard" },
];
const byId = Object.fromEntries(CATALOG.map((c) => [c.id, c]));
export const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
// Chrome for the AI's Browser app, downloaded once into ~/.ai-org-studio/tools/chrome (bin/studio.sh or Connect does it).
export function chromePath(dir) { try { return readFileSync(join(dir, "tools/chrome-path"), "utf8").trim() || ""; } catch { return ""; } }

export function makeConnectors({ dir, root, log = () => {}, node = process.execPath }) {
  const file = join(dir, "connectors.json");
  const read = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return { apps: {} }; } };
  const write = (v) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* ok */ } };

  // What the page may see: never key values, only whether each key is set (and a 4-character tail for recognition).
  function list() {
    const st = read().apps;
    const out = CATALOG.map((c) => {
      const s = st[c.id] || {};
      const keys = (c.keys || []).map((k) => ({ env: k.env, label: k.label, hint: k.hint || "", secret: k.secret !== false, optional: !!k.optional,
        set: !!s.keys?.[k.env], tail: s.keys?.[k.env] && k.secret !== false ? `…${String(s.keys[k.env]).slice(-4)}` : s.keys?.[k.env] || "" }));
      const ready = !!c.builtin || (c.oauth ? !!s.enabled : (c.keys || []).every((k) => k.optional || s.keys?.[k.env]));
      // GitHub is on unless switched off (it only uses gh). Everything else, incl. Browser, is on only when connected.
      return { id: c.id, name: c.name, what: c.what, steps: c.steps, link: c.link || "", safety: c.safety || "", builtin: !!c.builtin, oauth: !!c.oauth, keys, enabled: c.id === "github" ? s.enabled !== false : !!s.enabled && ready, ready };
    });
    for (const [id, s] of Object.entries(st)) if (s.custom) out.push({ id, name: s.custom.name || id, what: s.custom.what || "Custom MCP server", custom: true, steps: [], keys: Object.keys(s.keys || {}).map((env) => ({ env, label: env, secret: true, set: true, tail: `…${String(s.keys[env]).slice(-4)}` })), enabled: !!s.enabled, ready: true,
      command: s.custom.url || [s.custom.command, ...(s.custom.args || [])].join(" ") });
    return out;
  }
  function set(id, { enabled, keys, custom } = {}) {
    const all = read(); const s = all.apps[id] || {};
    if (!byId[id] && !custom && !s.custom) throw new Error("Unknown app");
    if (custom) {
      if (!ID_RE.test(id)) throw new Error("Name: lowercase letters, digits and dashes");
      if (custom.url && !/^https:\/\/[^\s]+$/.test(custom.url)) throw new Error("The server address must start with https://");
      if (!custom.url && !/^[A-Za-z0-9@._\/-]+$/.test(custom.command || "")) throw new Error("Command: one program name, e.g. npx");
      s.custom = { name: String(custom.name || id).slice(0, 40), what: String(custom.what || "").slice(0, 120), url: custom.url || "", command: custom.url ? "" : custom.command,
        args: (custom.args || []).map(String).slice(0, 20) };
    }
    if (keys) { s.keys ||= {}; for (const [k, v] of Object.entries(keys)) { if (!/^[A-Z][A-Z0-9_]{1,60}$/.test(k)) continue; if (v === "" || v == null) delete s.keys[k]; else s.keys[k] = String(v).trim().slice(0, 4000); } }
    if (enabled !== undefined) s.enabled = !!enabled;
    all.apps[id] = s; write(all); log(`apps: ${id} ${s.enabled ? "on" : "off"}`);
    return list().find((x) => x.id === id);
  }
  function remove(id) { const all = read(); delete all.apps[id]; write(all); }

  // The MCP servers every engine should load. Keys are NOT in here: mcp-run.mjs reads them when the server starts.
  function servers() {
    const runner = join(root, "bin/mcp-run.mjs");
    return list().filter((a) => a.enabled && a.id !== "github").map((a) => {
      const c = byId[a.id], s = read().apps[a.id] || {};
      if (c?.remote || s.custom?.url) return { id: a.id, url: c?.remote || s.custom.url, bearerEnv: s.custom?.url && s.keys?.TOKEN ? "TOKEN" : "" };
      // The Studio folder is passed as an argument: Codex starts app servers with a cleaned environment.
      return { id: a.id, command: node, args: [runner, a.id, dir] };
    });
  }
  // Claude Code: a JSON file passed with --mcp-config, plus the tool names that need no "allow?" each time.
  function claudeConfig() {
    const mcpServers = {};
    for (const s of servers()) mcpServers[s.id] = s.url ? { type: "http", url: s.url } : { type: "stdio", command: s.command, args: s.args };
    const f = join(dir, "mcp-claude.json"); writeFileSync(f, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
    return { file: f, allow: Object.keys(mcpServers).map((id) => `mcp__${id}`) };
  }
  // Codex: -c overrides (no change to the user's own ~/.codex/config.toml). Connected apps are pre-approved.
  function codexConfig() {
    const out = [];
    for (const s of servers()) {
      const k = `mcp_servers.${s.id.replace(/-/g, "_")}`;
      if (s.url) out.push(`${k}.url=${JSON.stringify(s.url)}`);
      else out.push(`${k}.command=${JSON.stringify(s.command)}`, `${k}.args=${JSON.stringify(s.args)}`);
      out.push(`${k}.default_tools_approval_mode="approve"`, `${k}.startup_timeout_sec=60`);
    }
    return out;
  }
  // The run command for one app (used by mcp-run.mjs): the official package, its args, and its keys as environment.
  function launch(id) {
    const c = byId[id], s = read().apps[id] || {};
    if (s.custom && !s.custom.url) return { command: s.custom.command, args: s.custom.args || [], env: s.keys || {} };
    if (c?.local) return { command: process.execPath, args: [join(root, c.local)], env: s.keys || {} };
    if (!c?.pkg) throw new Error(`${id} has no local server`);
    const extra = Object.entries(c.argsFromKeys || {}).flatMap(([k, f]) => f(s.keys?.[k]));
    if (c.needsChrome) { const exe = chromePath(dir); if (exe) extra.push("--executable-path", exe); }
    return { command: "npx", args: ["-y", c.pkg, ...(c.args || []), ...extra], env: Object.fromEntries(Object.entries(s.keys || {}).filter(([k]) => (c.keys || []).some((x) => x.env === k && x.secret !== false))) };
  }
  // Check: start the server and ask it for its tool list (proves the key and the package work), then stop it.
  // Browser app: make sure Chrome for Testing is installed (≈150 MB, once), via Google's own @puppeteer/browsers.
  function installChrome() {
    return new Promise((ok) => {
      if (chromePath(dir) && existsSync(chromePath(dir))) return ok({ ok: true });
      const p = spawn("npx", ["-y", "@puppeteer/browsers", "install", "chrome-headless-shell@stable", "--path", join(dir, "tools/chrome"), "--format", "{{path}}"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      p.on("close", (code) => { const exe = out.trim().split("\n").pop().trim(); if (code === 0 && exe && existsSync(exe)) { writeFileSync(join(dir, "tools/chrome-path"), exe + "\n"); ok({ ok: true }); } else ok({ ok: false, detail: `Chrome download failed: ${err.trim().split("\n").slice(-1)[0] || `exit ${code}`}` }); });
      p.on("error", (e) => ok({ ok: false, detail: e.message }));
    });
  }
  async function check(id, { timeoutMs = 90000 } = {}) {
    if (byId[id]?.needsChrome) { mkdirSync(join(dir, "tools"), { recursive: true }); const r = await installChrome(); if (!r.ok) return r; }
    if (id === "github") return new Promise((ok) => { const p = spawn("gh", ["api", "user", "-q", ".login"], { env: { ...process.env, GH_PROMPT_DISABLED: "1" } }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("close", (code) => ok(code === 0 ? { ok: true, detail: `Signed in to GitHub as ${o.trim()}` } : { ok: false, detail: "GitHub CLI is not signed in. In Cloud Shell run: gh auth login" })); p.on("error", () => ok({ ok: false, detail: "GitHub CLI (gh) is not installed." })); });
    const srv = servers().find((s) => s.id === id) || (() => { const s = read().apps[id] || {}; const c = byId[id]; return c?.remote ? { id, url: c.remote } : { id, command: node, args: [join(root, "bin/mcp-run.mjs"), id, dir] }; })();
    if (srv.url) {
      try { const r = await fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-org-studio", version: "2.2" } } }) });
        return r.status === 401 ? { ok: true, detail: "Server reachable. It asks for sign-in through its own page the first time an AI uses it." } : { ok: r.ok, detail: `Server answered HTTP ${r.status}` }; }
      catch (e) { return { ok: false, detail: `Could not reach ${srv.url}: ${e.message}` }; }
    }
    return probeStdio(srv.command, srv.args, timeoutMs);
  }
  return { list, set, remove, servers, claudeConfig, codexConfig, launch, check, file };
}

// Talks MCP over stdio just enough to list tools (initialize → tools/list).
export function probeStdio(command, args, timeoutMs = 90000) {
  return new Promise((ok) => {
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] }); let buf = "", err = "", done = false;
    const finish = (r) => { if (done) return; done = true; try { p.kill(); } catch { /* gone */ } ok(r); };
    const t = setTimeout(() => finish({ ok: false, detail: `No answer within ${Math.round(timeoutMs / 1000)}s. ${err.trim().split("\n").slice(-2).join(" ")}`.trim() }), timeoutMs);
    p.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    p.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"); }
        if (m.id === 2) { clearTimeout(t); const n = m.result?.tools?.length || 0; finish(m.error ? { ok: false, detail: m.error.message } : { ok: true, detail: `Connected: ${n} tool${n === 1 ? "" : "s"} available`, tools: (m.result?.tools || []).map((x) => x.name).slice(0, 40) }); }
      }
    });
    p.on("error", (e) => { clearTimeout(t); finish({ ok: false, detail: `Could not start: ${e.message}` }); });
    p.on("close", (code) => { clearTimeout(t); finish({ ok: false, detail: `Stopped (exit ${code}). ${err.trim().split("\n").slice(-3).join(" ")}`.trim() }); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-org-studio", version: "2.2" } } }) + "\n");
  });
}
export const _test = { byId };
