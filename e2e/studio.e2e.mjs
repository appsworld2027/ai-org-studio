// End-to-end test of the Studio: real server, real browser terminal and PTY, stand-in GitHub CLI and engines.
// Run: node e2e/studio.e2e.mjs   (needs Playwright + Chromium installed; set PLAYWRIGHT_MODULE if not local)
// Checks map to the Feature Contract (ST-xx). Exit 1 on any failure.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const results = []; let failed = 0;
const check = async (id, name, fn) => {
  try { await fn(); results.push(`PASS ${id} ${name}`); }
  catch (e) { failed++; results.push(`FAIL ${id} ${name}: ${e.message.split("\n")[0]}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

const tmp = mkdtempSync(join(tmpdir(), "studio-e2e-"));
const port = await freePort();
const cfg = join(tmp, "config.json");
writeFileSync(cfg, JSON.stringify({ port, products: [{ name: "Parent Plus", repo: "appsworld2027/Parent-plus-", dir: join(ROOT, "e2e/product"),
  productionUrl: "", backlog: "docs/product/BACKLOG.md",
  prototypes: ["founders/prototypes/ParentPlus_Coach_Tutor_App.html"] }] }));
const failFlag = join(tmp, "gh-down");
const fakeEngine = (name) => `printf '${name} ready (mode=%s)\\n' "$STUDIO_MODE"; while IFS= read -r line; do printf '${name} heard: %s\\n' "$line"; done`;
const TOKEN = "e2e-test-key-0123456789";
const srv = spawn(process.execPath, [join(ROOT, "server/server.mjs")], {
  env: { ...process.env, STUDIO_CONFIG: cfg, STUDIO_PORT: String(port), STUDIO_HOST: "127.0.0.1", STUDIO_TOKEN: TOKEN, STUDIO_GH: join(ROOT, "e2e/fake/gh"),
    FAKE_GH_FAIL: failFlag, STUDIO_BOARD_TTL_MS: "500", STUDIO_POLL_MS: "1000",
    STUDIO_CMD_CLAUDE: fakeEngine("CLAUDE"), STUDIO_CMD_CODEX: fakeEngine("CODEX"), STUDIO_CMD_FREE: fakeEngine("FREE") },
  stdio: ["ignore", "pipe", "pipe"] });
let srvOut = ""; srv.stdout.on("data", (d) => (srvOut += d)); srv.stderr.on("data", (d) => (srvOut += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50 && !srvOut.includes("?k="); i++) await new Promise((r) => setTimeout(r, 100));

const browser = await chromium.launch();
try {
  await check("ST-13", "private: no key → 401, wrong key → 401, no WebSocket without cookie", async () => {
    let r = await fetch(`${base}/`); assert(r.status === 401, `home without key = ${r.status}`);
    r = await fetch(`${base}/api/board`); assert(r.status === 401, `api without key = ${r.status}`);
    r = await fetch(`${base}/?k=wrong`); assert(r.status === 401, `wrong key = ${r.status}`);
    r = await fetch(`${base}/vendor/../server/server.mjs`); assert(r.status === 401, "path trick without cookie");
    const up = await new Promise((ok) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET /pty?engine=claude HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${base}\r\n\r\n`)); s.on("data", (d) => { ok(d.toString().split("\r\n")[0]); s.destroy(); }); });
    assert(/401/.test(up), `websocket without cookie: ${up}`);
    assert(srvOut.includes(`?k=${TOKEN}`), "start-up output prints the private link");
  });

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/?k=${TOKEN}`);

  await check("ST-01", "layout: chat left, three tabs right, product name on top", async () => {
    await page.waitForSelector(".eng[data-eng=claude]");
    assert((await page.textContent("#productName")) === "Parent Plus", "product name");
    assert(await page.isVisible("#term .xterm"), "terminal visible");
    for (const t of ["Real app", "Prototype", "Agents"]) assert(await page.isVisible(`.rtab:has-text("${t}")`), `tab ${t}`);
    const c = await ctx.cookies(); const k = c.find((x) => x.name === "studio_key");
    assert(k && k.httpOnly && k.sameSite === "Strict", "HttpOnly SameSite=Strict cookie set");
    assert(!page.url().includes("k="), "key removed from the address bar");
  });

  const termText = () => page.evaluate(() => document.querySelector("#term .xterm-rows")?.innerText || "");
  const waitTerm = async (re, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await termText(); if (re.test(t)) return t; await page.waitForTimeout(150); } throw new Error(`terminal never showed ${re}; got: ${(await termText()).slice(-200)}`); };

  await check("ST-02", "Claude Code engine starts in the terminal and receives typing", async () => {
    await waitTerm(/CLAUDE ready \(mode=new\)/);
    await page.click("#term"); await page.keyboard.type("what is next on the backlog"); await page.keyboard.press("Enter");
    await waitTerm(/CLAUDE heard: what is next on the backlog/);
  });
  await check("ST-03/04", "switching engines starts Codex and the free engine; switching back keeps Claude's chat", async () => {
    await page.click(".eng[data-eng=codex]"); await waitTerm(/CODEX ready/);
    await page.click(".eng[data-eng=free]"); await waitTerm(/FREE ready/);
    await page.click(".eng[data-eng=claude]"); await waitTerm(/CLAUDE heard: what is next on the backlog/);
    assert((await page.getAttribute(".eng[data-eng=claude]", "aria-selected")) === "true", "Claude tab selected");
  });
  await check("ST-06", "reload re-attaches to the running chat; Continue last chat restarts in continue mode", async () => {
    await page.reload(); await waitTerm(/CLAUDE heard: what is next on the backlog/);
    await page.click("#btnContinue"); await waitTerm(/CLAUDE ready \(mode=continue\)/);
    await page.click("#btnRestart"); await waitTerm(/CLAUDE ready \(mode=new\)/);
  });
  await check("ST-09", "no Vercel URL → Prototype tab is the default and shows the HTML prototype", async () => {
    const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage(); await p2.goto(`${base}/?k=${TOKEN}`);
    await p2.waitForSelector("#pane-proto.show");
    const f = p2.frameLocator("#protoFrame"); await f.locator("h1[data-ok='1']").waitFor({ timeout: 5000 });
    await p2.click("#tab-app"); assert(await p2.isVisible("#appEmpty"), "Real app says no Vercel yet");
    await ctx2.close();
    // Raw HTTP (browsers normalise "..", which would hide a real traversal bug).
    const cookie = (await ctx.cookies()).find((c) => c.name === "studio_key");
    for (const path of ["/proto/..%2F..%2Fpackage.json", "/proto/%2e%2e%2fpackage.json", "/proto/../../package.json", "/proto/package.json"]) {
      const code = await new Promise((ok) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: studio_key=${cookie.value}\r\nConnection: close\r\n\r\n`)); let d = ""; s.on("data", (x) => (d += x)); s.on("end", () => ok(d.split(" ")[1])); });
      assert(code === "404", `${path} must be 404, got ${code}`);
    }
  });
  await check("ST-10", "Agents tab shows the live board from GitHub", async () => {
    await page.click("#tab-agents");
    await page.waitForSelector("#tracks .trk:not(.head)");
    const rows = await page.$$eval("#tracks .trk:not(.head) .name", (n) => n.map((x) => x.innerText));
    assert(rows.some((r) => /Overdue fees|overdue fees/.test(r) && /Quinn, tester/.test(r)), `fees row with Quinn: ${rows.join(" | ")}`);
    assert(rows.some((r) => /QA lab nightly/.test(r)), "QA-lab fix row");
    assert(rows.some((r) => /shipped/.test(r)), "shipped row");
    assert((await page.$$("#tracks .st.agent")).length >= 1, "an animated 'agent working' cell");
    assert(/Live from GitHub/.test(await page.textContent("#boardStatus")), "status line");
    assert((await page.$$("#feed a")).length >= 3, "feed has entries");
    assert(/Quinn/.test(await page.textContent("#focusStage") || ""), "top bar shows the active stage");
  });
  await check("ST-12", "GitHub down → clear message, the rest keeps working; recovers", async () => {
    writeFileSync(failFlag, "1");
    await page.waitForFunction(() => /could not refresh/.test(document.querySelector("#boardStatus").textContent), null, { timeout: 8000 });
    assert((await page.$$("#tracks .trk:not(.head)")).length > 0, "last board still shown");
    await page.click("#term"); await page.keyboard.type("still here"); await page.keyboard.press("Enter"); await waitTerm(/CLAUDE heard: still here/);
    rmSync(failFlag);
    await page.waitForFunction(() => /Live from GitHub/.test(document.querySelector("#boardStatus").textContent), null, { timeout: 8000 });
  });
  await check("ST-14", "keyboard: tabs reachable with arrow keys, visible focus", async () => {
    await page.focus("#tab-agents"); await page.keyboard.press("ArrowRight");
    assert((await page.getAttribute("#tab-app", "aria-selected")) === "true", "arrow moves to next tab");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert(outline && outline !== "none", `focus outline: ${outline}`);
  });
  await page.click("#tab-agents"); await page.waitForTimeout(300);
  await page.screenshot({ path: join(tmp, "studio.png") });
  await check("—", "no browser errors", async () => assert(!errors.length, errors.join(" | ")));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  await ctx.close();
} finally {
  await browser.close(); srv.kill("SIGTERM");
}
console.log(results.join("\n"));
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("--- server log ---\n" + srvOut.slice(-2000)); process.exit(1); }
rmSync(tmp, { recursive: true, force: true });
