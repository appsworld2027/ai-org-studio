#!/usr/bin/env node
// AI Org Product Studio — server. Runs in the founder's Cloud Shell; opened through Web Preview.
// Left panel: the real, unmodified Claude Code / Codex / free-engine programs in a browser terminal.
// Right panel: the product (Vercel or HTML prototype) and live agent status read from GitHub with the founder's gh login.
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { parseBacklog, buildBoard, feedFrom, appTarget } from "./status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const expand = (p = "") => p.replace(/^~(?=\/|$)/, HOME);
const CONFIG_FILE = process.env.STUDIO_CONFIG || join(ROOT, "studio.config.json");
const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
const product = config.products[0];
product.dir = expand(product.dir);
if (process.env.STUDIO_PRODUCTION_URL !== undefined) product.productionUrl = process.env.STUDIO_PRODUCTION_URL;
const PORT = Number(process.env.STUDIO_PORT || config.port || 8080);
const HOST = process.env.STUDIO_HOST || "0.0.0.0";
const TOKEN = process.env.STUDIO_TOKEN || randomBytes(18).toString("base64url");
const GH = process.env.STUDIO_GH || "gh";
const BOARD_TTL = Number(process.env.STUDIO_BOARD_TTL_MS || 25000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- auth: a random key in the first URL, then an HttpOnly cookie ----------
const COOKIE = "studio_key";
const same = (a = "", b = "") => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function cookieOk(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return !!m && same(m[1], TOKEN);
}
// Cloud Shell's Web Preview proxy may rewrite Host, so also accept the forwarded host and the preview host.
function originOk(req) {
  const o = req.headers.origin; if (!o) return false;
  let host; try { host = new URL(o).host; } catch { return false; }
  const ok = [req.headers.host, req.headers["x-forwarded-host"], process.env.WEB_HOST && `${PORT}-${process.env.WEB_HOST}`, process.env.STUDIO_ALLOW_HOST].filter(Boolean);
  const pass = ok.some((h) => String(h).split(",")[0].trim() === host);
  if (!pass) log(`terminal connection refused: origin ${host} not in [${ok.join(", ")}] (set STUDIO_ALLOW_HOST=${host} if this is you)`);
  return pass;
}

// ---------- static files (whitelist only) ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const STATIC = {
  "/": "public/index.html", "/app.js": "public/app.js", "/styles.css": "public/styles.css",
  "/vendor/xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
  "/vendor/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  "/vendor/addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
  "/vendor/addon-web-links.js": "node_modules/@xterm/addon-web-links/lib/addon-web-links.js",
};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src 'self' https:; connect-src 'self' wss: ws:; frame-ancestors 'self'",
};
function send(res, code, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(code, { "Content-Type": type, ...SECURITY_HEADERS, ...extra }); res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");

// ---------- GitHub reads through the founder's gh login ----------
function gh(args, timeout = 20000) {
  return new Promise((ok, fail) => execFile(GH, args, { timeout, maxBuffer: 32 << 20 }, (e, out, err) => e ? fail(new Error((err || e.message).toString().split("\n")[0])) : ok(out)));
}
const ghJson = async (path) => JSON.parse(await gh(["api", path]) || "null");
let boardCache = { at: 0, data: null, error: null, pending: null };
async function loadBoard() {
  const R = `repos/${product.repo}`;
  const [issues, pulls, runs, comments, backlogFile] = await Promise.all([
    ghJson(`${R}/issues?state=open&per_page=100`),
    ghJson(`${R}/pulls?state=open&per_page=100`),
    ghJson(`${R}/actions/runs?per_page=25`),
    ghJson(`${R}/issues/comments?sort=created&direction=desc&per_page=40`),
    ghJson(`${R}/contents/${product.backlog || "docs/product/BACKLOG.md"}`).catch(() => null),
  ]);
  const prBy = Object.fromEntries((pulls || []).map((p) => [p.number, p]));
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
  const board = buildBoard({ backlog, issues, runs: runs?.workflow_runs || [], previews });
  return { ...board, feed: feedFrom(comments), app: appTarget({ productionUrl: product.productionUrl, demo: board.demo }), updatedAt: new Date().toISOString() };
}
async function board() {
  if (boardCache.data && Date.now() - boardCache.at < BOARD_TTL) return boardCache;
  if (!boardCache.pending) boardCache.pending = loadBoard()
    .then((d) => { boardCache = { at: Date.now(), data: d, error: null, pending: null }; })
    .catch((e) => { log("board:", e.message); boardCache = { ...boardCache, at: Date.now(), error: e.message, pending: null }; });
  await boardCache.pending;
  return boardCache;
}

// ---------- prototypes: served from the product repo's main branch, whitelisted by config ----------
function prototype(name) {
  const p = (product.prototypes || []).find((x) => x.split("/").pop() === name);
  if (!p) return Promise.resolve(null);
  return new Promise((ok) => execFile("git", ["-C", product.dir, "show", `origin/main:${p}`], { maxBuffer: 64 << 20 }, (e, out) => {
    if (!e) return ok(out);
    const f = join(product.dir, p); ok(existsSync(f) ? readFileSync(f, "utf8") : null);
  }));
}

// ---------- engines: the official programs in a terminal ----------
const ENGINES = {
  claude: { name: "Claude Code", cmd: process.env.STUDIO_CMD_CLAUDE || `bash ${join(ROOT, "bin/engine.sh")} claude` },
  codex: { name: "Codex", cmd: process.env.STUDIO_CMD_CODEX || `bash ${join(ROOT, "bin/engine.sh")} codex` },
  free: { name: "Free engine", cmd: process.env.STUDIO_CMD_FREE || `bash ${join(ROOT, "bin/engine.sh")} free` },
};
const sessions = new Map(); // engine -> { term, buf, clients:Set, exited }
const MAX_BUF = 400_000;
function startSession(engine, mode = "new") {
  const old = sessions.get(engine);
  if (old && !old.exited) { old.replaced = true; try { old.term.kill(); } catch { /* gone */ } }
  const term = pty.spawn("bash", ["-lc", ENGINES[engine].cmd], {
    name: "xterm-256color", cols: 100, rows: 30, cwd: existsSync(product.dir) ? product.dir : HOME,
    env: { ...process.env, STUDIO: "1", STUDIO_MODE: mode, STUDIO_PRODUCT: product.name, STUDIO_REPO: product.repo, STUDIO_RULES: join(ROOT, "studio-rules.md"), COLORTERM: "truecolor" },
  });
  const s = { term, buf: "", clients: old?.clients || new Set(), exited: false };
  term.onData((d) => { s.buf = (s.buf + d).slice(-MAX_BUF); for (const c of s.clients) if (c.readyState === 1) c.send(d); });
  term.onExit(({ exitCode }) => {
    s.exited = true;
    if (s.replaced) return;
    const msg = `\r\n\x1b[90m— ${ENGINES[engine].name} ended (exit ${exitCode}). Press Restart, or Continue last chat. —\x1b[0m\r\n`;
    s.buf += msg; for (const c of s.clients) if (c.readyState === 1) c.send(msg);
  });
  sessions.set(engine, s);
  log(`engine ${engine} started (${mode})`);
  return s;
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") return send(res, 200, "ok");
  if (url.searchParams.get("k")) {
    if (!same(url.searchParams.get("k"), TOKEN)) return send(res, 401, "Wrong Studio key. Use the link printed when the Studio started.");
    return send(res, 302, "", "text/plain", { Location: "/", "Set-Cookie": `${COOKIE}=${TOKEN}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` });
  }
  if (!cookieOk(req)) return send(res, 401, "This Studio is private. Open it with the link printed in Cloud Shell when it started (bash ~/ai-org-studio/bin/studio.sh).");
  if (STATIC[url.pathname]) {
    const f = join(ROOT, STATIC[url.pathname]);
    return send(res, 200, readFileSync(f), TYPES[extname(f)] || "application/octet-stream");
  }
  if (url.pathname === "/api/config") {
    return json(res, 200, {
      product: { name: product.name, repo: product.repo, productionUrl: product.productionUrl || "", prototypes: (product.prototypes || []).map((p) => p.split("/").pop()) },
      engines: Object.entries(ENGINES).map(([id, e]) => ({ id, name: e.name, running: !!sessions.get(id) && !sessions.get(id).exited })),
      boardRefreshMs: Number(process.env.STUDIO_POLL_MS || 30000),
    });
  }
  if (url.pathname === "/api/board") {
    const b = await board();
    if (!b.data) return json(res, 503, { error: b.error || "not loaded", updatedAt: null });
    return json(res, 200, { ...b.data, stale: !!b.error, error: b.error });
  }
  if (url.pathname.startsWith("/proto/")) {
    const html = await prototype(decodeURIComponent(url.pathname.slice(7)));
    if (html == null) return send(res, 404, "Prototype not found");
    // Prototypes are the team's own design files; allow their inline scripts, but only inside this frame.
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-modals allow-popups" });
    return res.end(html);
  }
  send(res, 404, "Not found");
});

// ---------- WebSocket: one terminal per engine; reconnecting re-attaches with the scrollback ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  const engine = url.searchParams.get("engine");
  if (url.pathname !== "/pty" || !ENGINES[engine] || !cookieOk(req) || !originOk(req)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    let s = sessions.get(engine);
    if (!s || (s.exited && url.searchParams.get("mode"))) s = startSession(engine, url.searchParams.get("mode") || "new");
    s.clients.add(ws);
    if (s.buf) ws.send(s.buf);
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const cur = sessions.get(engine);
      if (m.t === "in" && typeof m.d === "string" && cur && !cur.exited) cur.term.write(m.d);
      else if (m.t === "resize" && cur && !cur.exited) { const c = Math.max(20, Math.min(400, m.cols | 0)), r = Math.max(5, Math.min(200, m.rows | 0)); try { cur.term.resize(c, r); } catch { /* exited */ } }
      else if (m.t === "restart") { const n = startSession(engine, m.mode === "continue" ? "continue" : "new"); n.clients.add(ws); ws.send("\x1bc"); }
    });
    ws.on("close", () => sessions.get(engine)?.clients.delete(ws));
  });
});

server.listen(PORT, HOST, () => {
  const web = process.env.WEB_HOST ? `https://${PORT}-${process.env.WEB_HOST}` : `http://localhost:${PORT}`;
  log(`AI Org Studio for ${product.name} is running.`);
  console.log(`\n  Open this link (it carries your private key):\n  ${web}/?k=${TOKEN}\n`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const s of sessions.values()) { try { s.term.kill(); } catch { /* gone */ } } process.exit(0); });
export { server };
