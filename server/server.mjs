#!/usr/bin/env node
// AI Org Studio — server. Product-agnostic: any GitHub repo can be added as a product.
// Runs in the user's own cloud machine (Google Cloud Shell, GitHub Codespaces, or any Linux box).
// Left panel: Claude Code or Codex (their official programs, the user's own login) in a browser terminal,
//   or "Other models" — a chat the Studio draws itself, on any OpenAI-compatible model (free or paid) with the user's key.
// Right panel: the product's real app (Vercel) or HTML prototype, and live agent status read from GitHub.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { execFile, spawn, execFileSync as require_execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { parseBacklog, buildBoard, feedFrom, appTarget } from "./status.mjs";
import { makeStore, expand, repoOf, validUrl, HOME } from "./store.mjs";
import { PROVIDERS, publicProviders, sortModels } from "./providers.mjs";
import { runTurn } from "./agent.mjs";
import { UPLOAD_DIR, UPLOAD_MAX, safeUploadName, readRaw, ensureIgnored, pruneUploads } from "./uploads.mjs";
import { publicUrl, platform } from "./platform.mjs";
import { ENGINE_MODELS, plan as teamPlanFor, parseAgent } from "./team.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const store = makeStore();
const settings = (() => { try { return JSON.parse(readFileSync(process.env.STUDIO_CONFIG || join(ROOT, "studio.config.json"), "utf8")); } catch { return {}; } })();
const PORT = Number(process.env.STUDIO_PORT || settings.port || 8484);
const HOST = process.env.STUDIO_HOST || "0.0.0.0";
const TOKEN = process.env.STUDIO_TOKEN || randomBytes(18).toString("base64url");
const GH = process.env.STUDIO_GH || "gh";
const BOARD_TTL = Number(process.env.STUDIO_BOARD_TTL_MS || 25000);
const WORKSPACE = expand(process.env.STUDIO_WORKSPACE || settings.workspace || "~/studio-products");
const RULES = join(ROOT, "studio-rules.md");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// One-time migration: a studio.config.json "products" list (v1) seeds the products store.
if (!store.products.raw().length && Array.isArray(settings.products)) for (const p of settings.products) store.products.save({ id: store.products.freeId(p.name), ...p });

// ---------- auth: a random key in the first URL, then an HttpOnly cookie ----------
const COOKIE = "studio_key";
const same = (a = "", b = "") => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOk = (req) => { const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`)); return !!m && same(m[1], TOKEN); };
// Cross-site protection for WebSockets and state-changing requests. Proxies (Cloud Shell, Codespaces) may rewrite Host.
function originOk(req) {
  const o = req.headers.origin; if (!o) return false;
  let host; try { host = new URL(o).host; } catch { return false; }
  const pub = publicUrl(PORT); let pubHost = ""; try { pubHost = new URL(pub).host; } catch { /* none */ }
  const ok = [req.headers.host, req.headers["x-forwarded-host"], pubHost, process.env.STUDIO_ALLOW_HOST].filter(Boolean).map((h) => String(h).split(",")[0].trim());
  if (ok.includes(host)) return true;
  // Behind Cloud Shell / Codespaces proxies, the Host the server sees can differ from the address in the browser.
  // Browsers mark requests made by the page itself with Sec-Fetch-Site: same-origin; web pages cannot set or fake it.
  if (req.headers["sec-fetch-site"] === "same-origin") { rememberPublicUrl(o); return true; }
  // WebSocket upgrades carry no Sec-Fetch-Site. Accept the address the Studio was opened at (remembered at the key link
  // or from the page's own requests), and this port's address on Cloud Shell / Codespaces.
  if (learnedOrigins().includes(o) || isOwnProxyOrigin(o)) return true;
  log(`blocked a request from ${host} (allowed: ${ok.join(", ")}). If this is you, restart with STUDIO_ALLOW_HOST=${host}`);
  return false;
}
// This port's own address behind the Cloud Shell or Codespaces proxy (only those Google/GitHub domains, only this port).
function isOwnProxyOrigin(o) {
  let u; try { u = new URL(o); } catch { return false; }
  if (u.protocol !== "https:") return false;
  return (u.hostname.startsWith(`${PORT}-`) && /\.cloudshell\.dev$/.test(u.hostname)) || (/-\d+\.app\.github\.dev$/.test(u.hostname) && u.hostname.endsWith(`-${PORT}.app.github.dev`));
}
const learnedOrigins = () => { try { return [readFileSync(join(store.dir, "public-url"), "utf8").trim()]; } catch { return []; } };
// The address you opened the Studio at, so `studio.sh` can print the right link next time (Cloud Shell may not tell us).
function rememberPublicUrl(origin) {
  if (!/^https:\/\//.test(origin) || /localhost|127\.0\.0\.1|None/.test(origin) || !isOwnProxyOrigin(origin)) return;
  const f = join(store.dir, "public-url");
  try { if (readFileSync(f, "utf8").trim() === origin) return; } catch { /* first time */ }
  try { writeFileSync(f, origin + "\n", { mode: 0o600 }); log(`remembered the Studio address: ${origin}`); } catch { /* read-only */ }
}

// ---------- static files (whitelist only) ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const STATIC = {
  "/": "public/index.html", "/app.js": "public/app.js", "/chat.js": "public/chat.js", "/styles.css": "public/styles.css",
  "/vendor/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js", "/vendor/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  "/vendor/addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js", "/vendor/addon-web-links.js": "node_modules/@xterm/addon-web-links/lib/addon-web-links.js",
};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-src 'self' https:; connect-src 'self' wss: ws:; frame-ancestors 'self'",
};
const send = (res, code, body, type = "text/plain; charset=utf-8", extra = {}) => { res.writeHead(code, { "Content-Type": type, ...SECURITY_HEADERS, ...extra }); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");
const readBody = (req, limit = 1 << 20) => new Promise((ok, fail) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > limit) { fail(new Error("too large")); req.destroy(); } }); req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { fail(new Error("bad JSON")); } }); });

// ---------- shell helpers ----------
const run = (cmd, args, opts = {}) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 120000, maxBuffer: 32 << 20, ...opts }, (e, out, err) => e ? fail(new Error((err || e.message).toString().trim().split("\n").slice(-1)[0])) : ok(out)));
const gh = (args, timeout = 20000) => run(GH, args, { timeout });
const ghJson = async (path) => JSON.parse(await gh(["api", path]) || "null");

// ---------- products ----------
const products = () => store.products.list();
const productOf = (id) => store.products.get(id) || products()[0] || null;
async function detectPrototypes(dir) {
  try { const out = await run("git", ["-C", dir, "ls-files", "*.html"]); return out.split("\n").filter((f) => /(^|\/)(prototypes?|mockups?|design|founders)\//i.test(f) && !/node_modules|dist\/|build\//.test(f)).slice(0, 20); } catch { return []; }
}
async function addProduct({ repo, name, productionUrl }) {
  const full = repoOf(repo); if (!full) throw new Error("Use the GitHub name, like owner/repo, or its github.com link.");
  if (!validUrl(productionUrl)) throw new Error("The app link must start with https://");
  const meta = JSON.parse(await gh(["repo", "view", full, "--json", "name,nameWithOwner,homepageUrl,defaultBranchRef"]).catch((e) => { throw new Error(`GitHub could not open ${full}: ${e.message}`); }));
  const id = store.products.freeId(name || meta.name);
  const dir = join(WORKSPACE, id);
  if (!existsSync(join(dir, ".git"))) await run(GH, ["repo", "clone", meta.nameWithOwner, dir, "--", "--quiet"], { timeout: 600000 });
  const prototypes = await detectPrototypes(dir);
  return store.products.save({ id, name: name || meta.name, repo: meta.nameWithOwner, dir, productionUrl: productionUrl || meta.homepageUrl || "", prototypes });
}

// ---------- agent board per product (cached) ----------
const boards = new Map();
async function loadBoard(p) {
  const R = `repos/${p.repo}`;
  const [issues, pulls, runs, comments, backlogFile] = await Promise.all([
    ghJson(`${R}/issues?state=open&per_page=100`), ghJson(`${R}/pulls?state=open&per_page=100`), ghJson(`${R}/actions/runs?per_page=25`),
    ghJson(`${R}/issues/comments?sort=created&direction=desc&per_page=40`), ghJson(`${R}/contents/${p.backlog || "docs/product/BACKLOG.md"}`).catch(() => null),
  ]);
  const prBy = Object.fromEntries((pulls || []).map((x) => [x.number, x]));
  for (const i of issues) if (i.pull_request && prBy[i.number]) Object.assign(i, { branch: prBy[i.number].head.ref, head: prBy[i.number].head });
  const backlog = backlogFile?.content ? parseBacklog(Buffer.from(backlogFile.content, "base64").toString("utf8")) : [];
  const previews = {};
  for (const i of issues.filter((x) => x.pull_request && x.labels.some((l) => l.name === "ai:founder-test") && x.head?.sha)) {
    try {
      for (const d of (await ghJson(`${R}/deployments?sha=${i.head.sha}&per_page=5`)) || []) {
        const st = ((await ghJson(`${R}/deployments/${d.id}/statuses?per_page=5`)) || []).find((s) => s.state === "success" && s.environment_url);
        if (st) { previews[i.branch] = st.environment_url; break; }
      }
    } catch { /* no preview yet */ }
  }
  const b = buildBoard({ backlog, issues, runs: runs?.workflow_runs || [], previews });
  return { ...b, aiOrg: issues.some((i) => i.labels.some((l) => String(l.name).startsWith("ai:"))) || backlog.length > 0, feed: feedFrom(comments), app: appTarget({ productionUrl: p.productionUrl, demo: b.demo }), updatedAt: new Date().toISOString() };
}
async function board(p) {
  const c = boards.get(p.id) || { at: 0, data: null, error: null, pending: null }; boards.set(p.id, c);
  if (c.data && Date.now() - c.at < BOARD_TTL) return c;
  if (!c.pending) c.pending = loadBoard(p).then((d) => Object.assign(c, { at: Date.now(), data: d, error: null, pending: null }))
    .catch((e) => { log(`board ${p.id}:`, e.message); Object.assign(c, { at: Date.now(), error: e.message, pending: null }); });
  await c.pending; return c;
}

// ---------- prototypes: from the product's default branch, whitelisted ----------
function prototype(p, name) {
  const f = (p.prototypes || []).find((x) => x.split("/").pop() === name); if (!f) return Promise.resolve(null);
  return new Promise((ok) => execFile("git", ["-C", p.dir, "show", `origin/HEAD:${f}`], { maxBuffer: 64 << 20 }, (e, out) => {
    if (!e) return ok(out); const local = join(p.dir, f); ok(existsSync(local) ? readFileSync(local, "utf8") : null);
  }));
}

// ---------- terminal engines (Claude Code, Codex): official programs, user's own login ----------
const TERMINAL = {
  claude: { name: "Claude Code", cmd: process.env.STUDIO_CMD_CLAUDE || `bash ${join(ROOT, "bin/engine.sh")} claude` },
  codex: { name: "Codex", cmd: process.env.STUDIO_CMD_CODEX || `bash ${join(ROOT, "bin/engine.sh")} codex` },
};
const sessions = new Map(); // `${product}:${engine}` -> { term, buf, clients, exited }
const MAX_BUF = 400_000;
// Model / effort chosen above the Claude Code or Codex screen (per product + engine), applied on (re)start.
const termPrefs = () => store.readJson("terminal-prefs.json", {});
function startSession(p, engine, mode = "new") {
  const pref = termPrefs()[`${p.id}:${engine}`] || {};
  const key = `${p.id}:${engine}`, old = sessions.get(key);
  if (old && !old.exited) { old.replaced = true; try { old.term.kill(); } catch { /* gone */ } }
  const term = pty.spawn("bash", ["-c", TERMINAL[engine].cmd], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: existsSync(p.dir) ? p.dir : HOME,
    env: { ...process.env, STUDIO: "1", STUDIO_MODE: mode, STUDIO_PRODUCT: p.name, STUDIO_REPO: p.repo, STUDIO_RULES: RULES, COLORTERM: "truecolor",
      STUDIO_MODEL: /^[A-Za-z0-9._:\/-]{0,80}$/.test(pref.model || "") ? pref.model || "" : "", STUDIO_EFFORT: EFFORTS.includes(pref.effort) && pref.effort !== "default" ? pref.effort : "" },
  });
  const s = { term, buf: "", clients: old?.clients || new Set(), exited: false };
  term.onData((d) => { s.buf = (s.buf + d).slice(-MAX_BUF); for (const c of s.clients) if (c.readyState === 1) c.send(d); });
  term.onExit(({ exitCode }) => {
    s.exited = true; if (s.replaced) return;
    const msg = `\r\n\x1b[90m— ${TERMINAL[engine].name} ended (exit ${exitCode}). Press Restart, or Continue last chat. —\x1b[0m\r\n`;
    s.buf += msg; for (const c of s.clients) if (c.readyState === 1) c.send(msg);
  });
  sessions.set(key, s); log(`${p.id}: ${engine} started (${mode})`); return s;
}

// ---------- model choices above the Claude Code / Codex screens ----------
const TERMINAL_CHOICES = {
  claude: { models: [{ id: "", name: "Default (Claude Code decides)" }, { id: "opus", name: "Opus — strongest" }, { id: "sonnet", name: "Sonnet — balanced" }, { id: "haiku", name: "Haiku — fastest" }],
    efforts: ["default", "low", "medium", "high", "xhigh", "max"] },
  codex: { models: [{ id: "", name: "Default (Codex decides)" }], efforts: ["default", "low", "medium", "high", "xhigh"], freeText: true },
};

// ---------- the AI Org team: which agent uses which model ----------
// Agents come from the product's AI Org handbook (manifest → handbook repo, org/agents/*.md), read through gh.
const teamCache = new Map();
async function teamAgents(p) {
  const hit = teamCache.get(p.repo); if (hit && Date.now() - hit.at < 600000) return hit.agents;
  let handbook = "appsworld2027/parent-plus-ai-org", ref = "main";
  try { const m = JSON.parse(readFileSync(join(p.dir, ".ai-org/manifest.json"), "utf8")); handbook = m.handbook?.repo || handbook; ref = m.handbook?.ref || ref; } catch { /* not an AI Org product: default handbook */ }
  const list = (await ghJson(`repos/${handbook}/contents/org/agents?ref=${ref}`)).filter((f) => f.name.endsWith(".md"));
  const agents = await Promise.all(list.map(async (f) => { const c = await ghJson(`repos/${handbook}/contents/${f.path}?ref=${ref}`); return parseAgent(Buffer.from(c.content, "base64").toString("utf8"), f.name.replace(/\.md$/, "")); }));
  teamCache.set(p.repo, { at: Date.now(), agents }); return agents;
}
async function teamPlan(p) {
  const saved = store.readJson("team.json", {})[p.id] || {};
  // Default availability: what this machine can run. Free models need an NVIDIA key in the Studio (or the AI Org's GitHub secret).
  const has = (bin) => { try { return !!execFileSyncSafe("bash", ["-lc", `command -v ${bin}`]); } catch { return false; } };
  const nvidia = !!store.keys.get("nvidia")?.key;
  const available = saved.availability || { "claude:opus": has("claude"), "claude:sonnet": has("claude"), "claude:haiku": has("claude"), "codex:default": has("codex"), "free:nemotron": nvidia, "free:mistral": nvidia };
  let agents = [], error = "";
  try { agents = await teamAgents(p); } catch (e) { error = `Could not read the AI Org team: ${e.message}`; }
  return { models: ENGINE_MODELS.map((m) => ({ id: m.id, name: m.name, cost: m.cost, available: !!available[m.id] })), rows: teamPlanFor({ agents, available, overrides: saved.overrides || {} }), error,
    note: "The AI Org's background agents use this table once the AI Org reads it (next AI Org update). In the Studio chat, pick any model directly." };
}
const execFileSyncSafe = (cmd, args) => { try { return require_execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 }).trim(); } catch { return ""; } };

// ---------- "Other models" chat (Studio-drawn) ----------
const providerConf = (id) => {
  const def = PROVIDERS[id]; if (!def) return null;
  const saved = store.keys.get(id) || {};
  const base = def.custom ? saved.base : def.base;
  if (!base) return null;
  return { id, base, key: saved.key || (def.needsKey ? null : undefined), extraHeaders: id === "openrouter" ? { "HTTP-Referer": "https://github.com/appsworld2027/ai-org-studio", "X-Title": "AI Org Studio" } : {} };
};
async function listModels(id) {
  const pc = providerConf(id); if (!pc) throw new Error("Set up this provider first.");
  if (PROVIDERS[id].needsKey && !pc.key) throw new Error("Add your key first.");
  const r = await fetch(`${pc.base.replace(/\/$/, "")}/models`, { headers: pc.key ? { Authorization: `Bearer ${pc.key}`, ...pc.extraHeaders } : {}, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(r.status === 401 ? "The key was rejected." : `The provider answered ${r.status}.`);
  const j = await r.json();
  // The Studio's agent needs tool use; drop models that say they cannot do it (OpenRouter publishes this per model).
  const usable = (j.data || j.models || []).filter((m) => !Array.isArray(m.supported_parameters) || m.supported_parameters.includes("tools"));
  return sortModels(id, usable.map((m) => (m.id || m.name || "").replace(/^models\//, "")));
}
function systemPromptFor(p) {
  let rules = ""; try { rules = readFileSync(RULES, "utf8"); } catch { /* none */ }
  const extra = ["AGENTS.md", "CLAUDE.md"].map((f) => { try { return `\n\n## ${f} (from the product)\n` + readFileSync(join(p.dir, f), "utf8").slice(0, 12000); } catch { return ""; } }).join("");
  return `You are the AI product team inside AI Org Studio, working on the product "${p.name}" (GitHub ${p.repo}). Your tools act inside its folder.\n\n${rules}${extra}`;
}
const live = new Map(); // `${product}:${chat}` -> { abort, pending: Map(callId -> resolve), clients:Set }
const EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
async function chatTurn(p, chatId, text, auto, effort, wsEmit) {
  const c = store.chats.get(p.id, chatId); if (!c) throw new Error("Chat not found");
  const pc = providerConf(c.provider); if (!pc) throw new Error("This chat's provider is not set up. Open Keys.");
  if (PROVIDERS[c.provider].needsKey && !pc.key) throw new Error("Add your key for this provider under Keys.");
  const key = `${p.id}:${chatId}`; if (live.get(key)?.abort) throw new Error("Still working on the last message.");
  const L = live.get(key) || { pending: new Map(), clients: new Set() }; live.set(key, L);
  const ac = new AbortController(); L.abort = ac;
  const emit = (e) => { for (const ws of L.clients) if (ws.readyState === 1) ws.send(JSON.stringify(e)); wsEmit?.(e); };
  c.messages.push({ role: "user", content: text });
  if (c.title === "New chat") c.title = text.replace(/\s+/g, " ").slice(0, 60);
  store.chats.save(p.id, c);
  try {
    if (effort) { c.effort = effort; }
    await runTurn({ messages: c.messages, provider: pc, model: c.model, effort: c.effort, root: p.dir, systemPrompt: systemPromptFor(p), signal: ac.signal, emit,
      approve: (call) => auto ? Promise.resolve(true) : new Promise((ok) => L.pending.set(call.id, ok)),
      askUser: (q) => new Promise((ok) => L.pending.set(q.id, ok)) });
  } catch (e) { if (!ac.signal.aborted) emit({ t: "error", message: e.message }); }
  finally { L.abort = null; L.pending.clear(); store.chats.save(p.id, c); emit({ t: "idle" }); }
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x"), path = url.pathname;
    if (path === "/healthz") return send(res, 200, "ok");
    if (url.searchParams.get("k")) {
      if (!same(url.searchParams.get("k"), TOKEN)) return send(res, 401, "Wrong Studio key. Use the link printed when the Studio started.");
      if (req.headers["x-forwarded-host"]) rememberPublicUrl(`https://${String(req.headers["x-forwarded-host"]).split(",")[0].trim()}`);
      return send(res, 302, "", "text/plain", { Location: "/", "Set-Cookie": `${COOKIE}=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    if (!cookieOk(req)) return send(res, 401, "This Studio is private. Open it with the link printed when it started (bash ~/ai-org-studio/bin/studio.sh).");
    if (req.method !== "GET" && !originOk(req)) return json(res, 403, { error: "Blocked: request did not come from the Studio page." });
    if (STATIC[path]) { const f = join(ROOT, STATIC[path]); return send(res, 200, readFileSync(f), TYPES[extname(f)] || "application/octet-stream"); }

    if (path === "/api/config") return json(res, 200, {
      platform: platform(), workspace: WORKSPACE,
      products: products().map((p) => ({ id: p.id, name: p.name, repo: p.repo, productionUrl: p.productionUrl, prototypes: (p.prototypes || []).map((f) => f.split("/").pop()), ready: existsSync(p.dir) })),
      terminals: Object.entries(TERMINAL).map(([id, e]) => ({ id, name: e.name })),
      providers: publicProviders(store.keys.all()), boardRefreshMs: Number(process.env.STUDIO_POLL_MS || 30000),
    });
    if (path === "/api/products" && req.method === "POST") {
      const b = await readBody(req); try { const p = await addProduct(b); return json(res, 200, { ok: true, id: p.id }); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    let m;
    if ((m = path.match(/^\/api\/products\/([a-z0-9-]+)$/))) {
      const p = store.products.get(m[1]); if (!p) return json(res, 404, { error: "No such product" });
      if (req.method === "DELETE") { store.products.remove(p.id); return json(res, 200, { ok: true, note: `Removed from the Studio. The folder ${p.dir} was kept.` }); }
      if (req.method === "PATCH") {
        const b = await readBody(req); if (!validUrl(b.productionUrl)) return json(res, 400, { error: "The app link must start with https://" });
        const prototypes = b.rescan ? await detectPrototypes(p.dir) : p.prototypes;
        store.products.save({ ...p, name: b.name?.trim() || p.name, productionUrl: b.productionUrl ?? p.productionUrl, prototypes }); boards.delete(p.id); return json(res, 200, { ok: true });
      }
    }
    if ((m = path.match(/^\/api\/products\/([a-z0-9-]+)\/board$/))) {
      const p = store.products.get(m[1]); if (!p) return json(res, 404, { error: "No such product" });
      const b = await board(p); if (!b.data) return json(res, 503, { error: b.error || "not loaded", updatedAt: null });
      return json(res, 200, { ...b.data, stale: !!b.error, error: b.error });
    }
    if ((m = path.match(/^\/proto\/([a-z0-9-]+)\/(.+)$/))) {
      const p = store.products.get(m[1]); const html = p && await prototype(p, decodeURIComponent(m[2]));
      if (html == null) return send(res, 404, "Prototype not found");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-modals allow-popups" });
      return res.end(html);
    }
    // provider keys: write-only from the browser; the key itself never comes back
    if ((m = path.match(/^\/api\/providers\/([a-z]+)$/)) && PROVIDERS[m[1]]) {
      const id = m[1];
      if (req.method === "PUT") {
        const b = await readBody(req, 8192);
        if (PROVIDERS[id].custom && b.base && !/^https?:\/\/\S+$/.test(b.base)) return json(res, 400, { error: "Address must start with http:// or https://" });
        store.keys.set(id, { key: String(b.key || "").trim() || store.keys.get(id)?.key || "", base: PROVIDERS[id].custom ? String(b.base || "").trim() : undefined });
        try { const models = await listModels(id); return json(res, 200, { ok: true, models }); } catch (e) { return json(res, 200, { ok: true, models: PROVIDERS[id].models, warning: e.message }); }
      }
      if (req.method === "DELETE") { store.keys.set(id, null); return json(res, 200, { ok: true }); }
      if (path.endsWith(id) && req.method === "GET") { try { return json(res, 200, { models: await listModels(id) }); } catch (e) { return json(res, 200, { models: PROVIDERS[id].models, warning: e.message }); } }
    }
    if ((m = path.match(/^\/api\/products\/([a-z0-9-]+)\/terminal\/(claude|codex)$/))) {
      const p = store.products.get(m[1]); if (!p) return json(res, 404, { error: "No such product" });
      const all = termPrefs(), k = `${p.id}:${m[2]}`;
      if (req.method === "GET") return json(res, 200, { ...TERMINAL_CHOICES[m[2]], current: all[k] || {} });
      if (req.method === "PUT") {
        const b = await readBody(req, 4096), model = String(b.model || ""), effort = String(b.effort || "default");
        if (!/^[A-Za-z0-9._:\/-]{0,80}$/.test(model) || !EFFORTS.includes(effort)) return json(res, 400, { error: "Unknown model or effort" });
        all[k] = { model, effort }; store.writeJson("terminal-prefs.json", all);
        return json(res, 200, { ok: true, note: "Restart the chat to use it (Continue last chat keeps the conversation)." });
      }
    }
    if ((m = path.match(/^\/api\/products\/([a-z0-9-]+)\/team$/))) {
      const p = store.products.get(m[1]); if (!p) return json(res, 404, { error: "No such product" });
      if (req.method === "GET") return json(res, 200, await teamPlan(p));
      if (req.method === "PUT") {
        const b = await readBody(req, 16384), ov = {};
        for (const [slug, v] of Object.entries(b.overrides || {})) if (/^[a-z0-9-]{1,40}$/.test(slug) && (v === "" || ENGINE_MODELS.some((x) => x.id === v))) { if (v) ov[slug] = v; }
        const all = store.readJson("team.json", {}); all[p.id] = { overrides: ov, availability: b.availability && typeof b.availability === "object" ? Object.fromEntries(Object.entries(b.availability).filter(([k]) => ENGINE_MODELS.some((x) => x.id === k)).map(([k, v]) => [k, !!v])) : all[p.id]?.availability };
        store.writeJson("team.json", all); return json(res, 200, await teamPlan(p));
      }
    }
    // Attachments for the Claude Code / Codex composer: saved inside the product folder (git-ignored) so the official
    // program can read them by path, exactly as if the user had typed @path. Never executed by the Studio.
    if ((m = path.match(/^\/api\/products\/([a-z0-9-]+)\/uploads$/)) && req.method === "POST") {
      const p = store.products.get(m[1]); if (!p) return json(res, 404, { error: "No such product" });
      const rawName = decodeURIComponent(String(req.headers["x-file-name"] || "file"));
      const name = safeUploadName(rawName);
      if (!name) return json(res, 400, { error: "That file type is not supported. Images, PDFs, text, code, CSV, JSON and Office documents work." });
      let buf; try { buf = await readRaw(req, UPLOAD_MAX); } catch { return json(res, 413, { error: `Files up to ${UPLOAD_MAX >> 20} MB.` }); }
      if (!buf.length) return json(res, 400, { error: "Empty file" });
      const dir = join(p.dir, UPLOAD_DIR); mkdirSync(dir, { recursive: true });
      ensureIgnored(p.dir);
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14), file = `${stamp}-${randomBytes(2).toString("hex")}-${name}`;
      writeFileSync(join(dir, file), buf, { mode: 0o600 });
      pruneUploads(dir);
      return json(res, 200, { ok: true, path: `${UPLOAD_DIR}/${file}`, name: rawName.slice(0, 120), size: buf.length, image: /\.(png|jpe?g|gif|webp)$/i.test(file) });
    }
    if ((m = path.match(/^\/api\/products\/([a-z0-9-]+)\/chats$/))) {
      const p = store.products.get(m[1]); if (!p) return json(res, 404, { error: "No such product" });
      if (req.method === "GET") return json(res, 200, { chats: store.chats.list(p.id) });
      if (req.method === "POST") { const b = await readBody(req); if (!PROVIDERS[b.provider] || !b.model) return json(res, 400, { error: "Pick a provider and model." }); return json(res, 200, store.chats.create(p.id, { provider: b.provider, model: String(b.model).slice(0, 200) })); }
    }
    if ((m = path.match(/^\/api\/products\/([a-z0-9-]+)\/chats\/([a-z0-9-]+)$/))) {
      const p = store.products.get(m[1]); if (!p) return json(res, 404, { error: "No such product" });
      if (req.method === "GET") { const c = store.chats.get(p.id, m[2]); return c ? json(res, 200, c) : json(res, 404, { error: "Chat not found" }); }
      if (req.method === "DELETE") { store.chats.remove(p.id, m[2]); return json(res, 200, { ok: true }); }
      if (req.method === "PATCH") {
        const b = await readBody(req, 4096), c = store.chats.get(p.id, m[2]); if (!c) return json(res, 404, { error: "Chat not found" });
        if (live.get(`${p.id}:${c.id}`)?.abort) return json(res, 409, { error: "Wait until the current answer finishes." });
        if (!PROVIDERS[b.provider] || !b.model) return json(res, 400, { error: "Pick a provider and model." });
        c.provider = b.provider; c.model = String(b.model).slice(0, 200); store.chats.save(p.id, c); return json(res, 200, { ok: true });
      }
    }
    send(res, 404, "Not found");
  } catch (e) { log("http error:", e.message); if (!res.headersSent) json(res, 500, { error: e.message }); }
});

// ---------- WebSockets: /pty (terminals) and /chat (Studio-drawn chat) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 << 20 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x"), p = store.products.get(url.searchParams.get("product") || "");
  const deny = () => { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); };
  if (!cookieOk(req) || !originOk(req) || !p) return deny();
  if (url.pathname === "/pty") {
    const engine = url.searchParams.get("engine"); if (!TERMINAL[engine]) return deny();
    return wss.handleUpgrade(req, socket, head, (ws) => {
      const key = `${p.id}:${engine}`; let s = sessions.get(key);
      if (!s || (s.exited && url.searchParams.get("mode"))) s = startSession(p, engine, url.searchParams.get("mode") || "new");
      s.clients.add(ws); if (s.buf) ws.send(s.buf);
      ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        const cur = sessions.get(key);
        if (msg.t === "in" && typeof msg.d === "string" && cur && !cur.exited) cur.term.write(msg.d);
        else if (msg.t === "resize" && cur && !cur.exited) { try { cur.term.resize(Math.max(20, Math.min(400, msg.cols | 0)), Math.max(5, Math.min(200, msg.rows | 0))); } catch { /* exited */ } }
        else if (msg.t === "restart") { const n = startSession(p, engine, msg.mode === "continue" ? "continue" : "new"); n.clients.add(ws); ws.send("\x1bc"); }
      });
      ws.on("close", () => sessions.get(key)?.clients.delete(ws));
    });
  }
  if (url.pathname === "/chat") {
    const chatId = url.searchParams.get("chat") || ""; if (!store.chats.get(p.id, chatId)) return deny();
    return wss.handleUpgrade(req, socket, head, (ws) => {
      const key = `${p.id}:${chatId}`; const L = live.get(key) || { pending: new Map(), clients: new Set() }; live.set(key, L); L.clients.add(ws);
      if (L.abort) ws.send(JSON.stringify({ t: "busy" }));
      ws.on("message", (raw) => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        if (msg.t === "send" && typeof msg.text === "string" && msg.text.trim()) chatTurn(p, chatId, msg.text.slice(0, 20000), !!msg.auto, EFFORTS.includes(msg.effort) ? msg.effort : "").catch((e) => ws.send(JSON.stringify({ t: "error", message: e.message })));
        else if (msg.t === "approve" || msg.t === "deny") { const r = L.pending.get(msg.id); if (r) { L.pending.delete(msg.id); r(msg.t === "approve"); } }
        else if (msg.t === "answer" && typeof msg.answer === "string") { const r = L.pending.get(msg.id); if (r) { L.pending.delete(msg.id); r(msg.answer.slice(0, 2000)); } }
        else if (msg.t === "stop") { L.abort?.abort(); for (const r of L.pending.values()) r(false); L.pending.clear(); }
      });
      ws.on("close", () => L.clients.delete(ws));
    });
  }
  deny();
});

server.listen(PORT, HOST, () => {
  log(`AI Org Studio is running (${platform().name}), ${products().length} product(s).`);
  console.log(`\n  Open this link (it carries your private key):\n  ${publicUrl(PORT)}/?k=${TOKEN}\n`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const s of sessions.values()) { try { s.term.kill(); } catch { /* gone */ } } process.exit(0); });
export { server };
