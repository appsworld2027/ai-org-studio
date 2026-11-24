// End-to-end test of the Studio: real server, real browser, real terminal (PTY); stand-ins for GitHub, the engines and an AI model.
// Run: node e2e/studio.e2e.mjs   (needs Playwright + Chromium; set PLAYWRIGHT_MODULE if Playwright is not installed locally)
// Each check maps to the Feature Contract (docs/FEATURE_CONTRACT.md). Exit 1 on any failure.
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const results = []; let failed = 0;
const check = async (id, name, fn) => { try { await fn(); results.push(`PASS ${id} ${name}`); } catch (e) { failed++; results.push(`FAIL ${id} ${name}: ${e.message.split("\n")[0]}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rawGet = (port, path, cookie) => new Promise((ok) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${cookie ? `Cookie: studio_key=${cookie}\r\n` : ""}Connection: close\r\n\r\n`)); let d = ""; s.on("data", (x) => (d += x)); s.on("end", () => ok(d.split(" ")[1])); });

const tmp = mkdtempSync(join(tmpdir(), "studio-e2e-"));
const home = join(tmp, "studio-home"); mkdirSync(home);
// A real git repo stands in for the product (so prototypes come from git, as in real use).
const prod = join(tmp, "parent-plus"); mkdirSync(join(prod, "founders/prototypes"), { recursive: true });
writeFileSync(join(prod, "founders/prototypes/ParentPlus_Coach_Tutor_App.html"), readFileSync(join(ROOT, "e2e/product/founders/prototypes/ParentPlus_Coach_Tutor_App.html")));
writeFileSync(join(prod, "README.md"), "# Parent Plus\nCoach and parent app.\n");
const git = (...a) => execFileSync("git", ["-C", prod, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main"); git("add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
writeFileSync(join(home, "team.json"), JSON.stringify({ "parent-plus": { availability: { "claude:opus": false, "claude:sonnet": false, "claude:haiku": false, "codex:default": false, "free:nemotron": true, "free:mistral": true } } }));
writeFileSync(join(home, "products.json"), JSON.stringify({ products: [{ id: "parent-plus", name: "Parent Plus", repo: "appsworld2027/Parent-plus-", dir: prod, productionUrl: "", backlog: "docs/product/BACKLOG.md", prototypes: ["founders/prototypes/ParentPlus_Coach_Tutor_App.html"] }] }));

// Stand-in AI model (OpenAI-compatible): first answers with a file read, then a file write (needs approval), then text.
const modelPort = await freePort(); const modelLog = [];
const model = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    modelLog.push({ path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.url === "/v1/models") { res.writeHead(req.headers.authorization === "Bearer good-key" ? 200 : 401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "test/model-a", supported_parameters: ["tools"] }, { id: "test/model-b" }, { id: "test/no-tools", supported_parameters: ["temperature"] }] })); }
    const msgs = JSON.parse(body).messages, lastUserAt = msgs.map((m) => m.role).lastIndexOf("user"), toolsSeen = msgs.slice(lastUserAt).filter((m) => m.role === "tool").length;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content || "";
    if (/decide/i.test(lastUser)) {
      const answered = msgs.filter((m) => m.role === "tool").at(-1)?.content || "";
      const d = /chose/.test(answered) && msgs.at(-1).role === "tool" ? { content: `Noted: ${answered.replace("The product owner chose: ", "")}` }
        : { tool_calls: [{ index: 0, id: `ask${msgs.length}`, function: { name: "ask_user", arguments: JSON.stringify({ question: "Where should overdue fees show?", options: [{ label: "Top of the Fees screen", detail: "Fastest to find" }, { label: "A separate tab", detail: "More clicks" }], recommended: 0 }) } }] };
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`); return res.end("data: [DONE]\n\n");
    }
    const chunks = toolsSeen === 0 ? [{ tool_calls: [{ index: 0, id: "t1", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] }]
      : toolsSeen === 1 ? [{ tool_calls: [{ index: 0, id: "t2", function: { name: "write_file", arguments: '{"path":"docs/idea.md","content":"# Idea\\nDark mode"}' } }] }]
      : [{ content: "I read the README" }, { content: " and saved **docs/idea.md**. <img src=x onerror=alert(1)>" }];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const d of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(modelPort, "127.0.0.1");

const port = await freePort();
const failFlag = join(tmp, "gh-down");
const fakeEngine = (name) => `printf '${name} ready (mode=%s, product=%s) model=%s effort=%s\\n' "$STUDIO_MODE" "$STUDIO_PRODUCT" "$STUDIO_MODEL" "$STUDIO_EFFORT"; while IFS= read -r line; do line=$(printf '%s' "$line" | sed -e 's/\\x1b\\[200~/<paste>/g' -e 's/\\x1b\\[201~/<\\/paste>/g'); printf '${name} heard: %s\\n' "$line"; printf '%s\\n' "$line" >> "$STUDIO_HEARD_FILE"; done`;
const TOKEN = "e2e-test-key-0123456789";
const env = { ...process.env, STUDIO_HOME: home, STUDIO_PORT: String(port), STUDIO_HOST: "127.0.0.1", STUDIO_TOKEN: TOKEN, STUDIO_GH: join(ROOT, "e2e/fake/gh"),
  STUDIO_CONFIG: join(tmp, "none.json"), FAKE_GH_FAIL: failFlag, STUDIO_BOARD_TTL_MS: "500", STUDIO_POLL_MS: "1000", STUDIO_WORKSPACE: join(tmp, "ws"),
  STUDIO_HEARD_FILE: join(tmp, "heard.txt"), STUDIO_CMD_CLAUDE: fakeEngine("CLAUDE"), STUDIO_CMD_CODEX: fakeEngine("CODEX"), WEB_HOST: "", CODESPACE_NAME: "", STUDIO_PUBLIC_URL: "" };
const srv = spawn(process.execPath, [join(ROOT, "server/server.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let srvOut = ""; srv.stdout.on("data", (d) => (srvOut += d)); srv.stderr.on("data", (d) => (srvOut += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50 && !srvOut.includes("?k="); i++) await new Promise((r) => setTimeout(r, 100));

const browser = await chromium.launch();
try {
  await check("ST-13", "private: no key → 401, wrong key → 401, no WebSockets or writes without the key", async () => {
    let r = await fetch(`${base}/`); assert(r.status === 401, `home without key = ${r.status}`);
    r = await fetch(`${base}/api/config`); assert(r.status === 401, `api without key = ${r.status}`);
    r = await fetch(`${base}/?k=wrong`); assert(r.status === 401, `wrong key = ${r.status}`);
    for (const p of ["/pty?product=parent-plus&engine=claude", "/chat?product=parent-plus&chat=x"]) {
      const up = await new Promise((ok) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${base}\r\n\r\n`)); s.on("data", (d) => { ok(d.toString().split("\r\n")[0]); s.destroy(); }); });
      assert(/401/.test(up), `${p} without cookie: ${up}`);
    }
    assert(srvOut.includes(`?k=${TOKEN}`), "start-up output prints the private link");
  });

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on("dialog", (d) => { errors.push(`unexpected browser dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(`${base}/?k=${TOKEN}`);
  const cookie = (await ctx.cookies()).find((c) => c.name === "studio_key");

  await check("ST-13b", "cross-site writes are refused even with the cookie; a proxied same-origin page is accepted and its address remembered", async () => {
    let r = await fetch(`${base}/api/providers/nvidia`, { method: "PUT", headers: { Cookie: `studio_key=${cookie.value}`, Origin: "https://evil.example", "Content-Type": "application/json" }, body: '{"key":"x"}' });
    assert(r.status === 403, `cross-site PUT = ${r.status}`);
    r = await fetch(`${base}/api/providers/nvidia`, { method: "PUT", headers: { Cookie: `studio_key=${cookie.value}`, Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, body: '{"key":"x"}' });
    assert(r.status === 403, `cross-site PUT with Sec-Fetch-Site: cross-site = ${r.status}`);
    // Cloud Shell's proxy: browser address differs from the Host the server sees; the browser marks the page's own requests same-origin.
    r = await fetch(`${base}/api/products/parent-plus/terminal/claude`, { method: "PUT", headers: { Cookie: `studio_key=${cookie.value}`, Origin: `https://${port}-cs-1-abc.cs-asia-southeast1.cloudshell.dev`, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: '{"model":"","effort":"default"}' });
    assert(r.status === 200, `proxied same-origin PUT = ${r.status}`);
    assert(readFileSync(join(home, "public-url"), "utf8").trim() === `https://${port}-cs-1-abc.cs-asia-southeast1.cloudshell.dev`, "address remembered");
    // WebSockets carry no Sec-Fetch-Site: through the Cloud Shell proxy the chat must still connect; another site must not.
    const upgrade = (origin) => new Promise((ok) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET /pty?product=parent-plus&engine=claude HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: studio_key=${cookie.value}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`)); s.on("data", (d) => { ok(d.toString().split("\r\n")[0]); s.destroy(); }); });
    assert(/101/.test(await upgrade(`https://${port}-cs-1-abc.cs-asia-southeast1.cloudshell.dev`)), "chat connects through the Cloud Shell proxy");
    assert(/101/.test(await upgrade(`https://${port}-cs-9-other.cs-europe-west1.cloudshell.dev`)), "any Cloud Shell address for THIS port works (e.g. after a VM move)");
    assert(/401/.test(await upgrade(`https://9999-cs-1-abc.cs-asia-southeast1.cloudshell.dev`)), "another port's address is refused");
    assert(/401/.test(await upgrade(`https://${port}-cs-1.cloudshell.dev.evil.example`)), "look-alike domain refused");
    assert(/401/.test(await upgrade("https://evil.example")), "other site refused");
  });
  await check("ST-01", "layout: product picker, three AI choices on the left, three tabs on the right", async () => {
    await page.waitForSelector(".eng[data-eng=claude]");
    assert((await page.$eval("#productPick", (s) => s.selectedOptions[0].textContent)) === "Parent Plus", "product shown");
    for (const n of ["Claude Code", "Codex", "Other models"]) assert(await page.isVisible(`.eng:has-text("${n}")`), `engine ${n}`);
    for (const t of ["Real app", "Prototype", "Agents"]) assert(await page.isVisible(`.rtab:has-text("${t}")`), `tab ${t}`);
    assert(cookie && cookie.httpOnly && cookie.sameSite === "Strict", "HttpOnly SameSite=Strict cookie");
    assert(!page.url().includes("k="), "key removed from the address bar");
  });

  // Terminal text with wrapped lines joined (a narrow panel wraps long lines).
  const termText = () => page.evaluate(() => [...document.querySelectorAll("#term .xterm-rows > div")].map((r) => r.textContent.replace(/\s+$/, "")).join("\n").replace(/\n(?=\S)/g, (m, i, str) => (str.slice(Math.max(0, i - 1), i).match(/\S/) && false) ? "" : m) || "");
  const flat = async () => (await termText()).replace(/\n/g, "");
  const waitTerm = async (re, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await termText(); if (re.test(t) || re.test(await flat())) return t; await page.waitForTimeout(150); } throw new Error(`terminal never showed ${re}; got: ${(await termText()).slice(-200)}`); };

  await check("ST-02", "Claude Code screen starts for this product and receives typing", async () => {
    await waitTerm(/CLAUDE ready \(mode=new, product=Parent Plus\)/);
    await page.click("#term"); await page.keyboard.type("what is next on the backlog"); await page.keyboard.press("Enter");
    await waitTerm(/CLAUDE heard: what is next on the backlog/);
  });
  await check("ST-03", "Codex screen starts; switching back keeps Claude's chat", async () => {
    await page.click(".eng[data-eng=codex]"); await waitTerm(/CODEX ready/);
    await page.click(".eng[data-eng=claude]"); await waitTerm(/CLAUDE heard: what is next on the backlog/);
  });
  await check("ST-06", "reload re-attaches; Continue last chat and Restart work", async () => {
    await page.reload(); await waitTerm(/CLAUDE heard: what is next on the backlog/);
    await page.click("#btnContinue"); await waitTerm(/CLAUDE ready \(mode=continue/);
    await page.click("#btnRestart"); await waitTerm(/CLAUDE ready \(mode=new/);
  });

  await check("ST-24", "chat box under Claude Code: multi-line text, Ctrl+V image paste, attach a file; delivered to the program as one message with file paths", async () => {
    await page.click(".eng[data-eng=claude]"); await waitTerm(/CLAUDE ready/);
    await page.fill("#tAsk", "Fix the spacing on Today\nKeep the colours");
    // Ctrl+V of an image from the clipboard
    await page.evaluate(() => {
      const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bin], "image.png", { type: "image/png" }));
      document.querySelector("#tAsk").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.setInputFiles("#tFile", { name: "brief.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") });
    await page.waitForFunction(() => document.querySelectorAll("#tChips .chip:not(.up)").length === 2, null, { timeout: 8000 });
    assert(await page.isVisible("#tChips .chip img"), "image thumbnail shown");
    await page.setInputFiles("#tFile", { name: "run.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await page.waitForSelector("#tChips .chip.bad", { timeout: 8000 });
    await page.click("#tChips .chip.bad button");
    await page.press("#tAsk", "Enter");
    await waitTerm(/CLAUDE heard: .*Attached: @\.studio-uploads\/\S+-pasted-\S+\.png @\.studio-uploads\/\S+-brief\.pdf/);
    const heard = readFileSync(join(tmp, "heard.txt"), "utf8");
    assert(/<paste>Fix the spacing on Today/.test(heard) && /Keep the colours/.test(heard), `message arrives as one paste: ${heard.slice(-300)}`);
    const up = readdirSync(join(prod, ".studio-uploads"));
    assert(up.some((f) => f.endsWith("-brief.pdf")) && up.some((f) => /pasted-.*\.png$/.test(f)), `files saved in the product: ${up}`);
    assert(!up.some((f) => f.endsWith(".exe")), "unsupported type refused");
    assert(readFileSync(join(prod, ".git/info/exclude"), "utf8").includes(".studio-uploads/"), "uploads kept out of git");
    assert(execFileSync("git", ["-C", prod, "status", "--porcelain"]).toString().trim() === "", "git sees no new files");
    assert((await page.$$("#tChips .chip")).length === 0 && (await page.inputValue("#tAsk")) === "", "box cleared after send");
    await page.click(".eng[data-eng=codex]"); await waitTerm(/CODEX ready/);
    await page.fill("#tAsk", "hello codex"); await page.setInputFiles("#tFile", { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# n") });
    await page.waitForFunction(() => document.querySelectorAll("#tChips .chip:not(.up)").length === 1, null, { timeout: 8000 });
    await page.press("#tAsk", "Enter");
    await waitTerm(/CODEX heard: .*Attached: \.studio-uploads\/\S+-notes\.md/);
    assert(!/@\.studio-uploads\/\S+-notes/.test(await termText()), "Codex gets plain paths (no @)");
  });
  await check("ST-15", "Other models: add a custom model server and key (key never returned to the page)", async () => {
    await page.click(".eng[data-eng=other]"); await page.waitForSelector("#chatPane:not([hidden])");
    await page.click("#btnKeys"); await page.selectOption("#kProvider", "custom");
    await page.fill("#kBase", `http://127.0.0.1:${modelPort}/v1`); await page.fill("#kKey", "bad-key"); await page.click("#kSave");
    await page.waitForFunction(() => /rejected/.test(document.querySelector("#kStatus").textContent), null, { timeout: 8000 });
    await page.fill("#kKey", "good-key"); await page.click("#kSave");
    await page.waitForFunction(() => /2 models available/.test(document.querySelector("#kStatus").textContent), null, { timeout: 8000 });
    await page.click("#formKeys button[value=cancel]");
    const cfg = await (await page.request.get(`${base}/api/config`)).text();
    assert(!cfg.includes("good-key"), "key not in /api/config");
    const mode = statSync(join(home, "keys.json")).mode & 0o777; assert(mode === 0o600, `keys.json mode ${mode.toString(8)}`);
    const opts = await page.$$eval("#modelPick option", (o) => o.map((x) => x.value));
    assert(opts.includes("test/model-b") && !opts.includes("test/no-tools"), `models listed, tool-less hidden: ${opts}`);
  });
  await check("ST-16", "Other models: chat streams, reads freely, asks before writing, writes after Allow, shows text safely", async () => {
    await page.selectOption("#modelPick", "test/model-a");
    await page.fill("#ask", "Write down my dark mode idea"); await page.keyboard.press("Enter");
    await page.waitForSelector(".toolcard:has-text('Read')", { timeout: 8000 });
    await page.waitForSelector(".toolcard.ask button:has-text('Allow')", { timeout: 8000 });
    assert(!existsSync(join(prod, "docs/idea.md")), "nothing written before Allow");
    await page.click(".toolcard.ask button:has-text('Allow')");
    await page.waitForSelector(".msg.ai:has-text('I read the README')", { timeout: 8000 });
    assert(readFileSync(join(prod, "docs/idea.md"), "utf8").includes("Dark mode"), "file written after Allow");
    assert(await page.isVisible(".msg.ai b:has-text('docs/idea.md')"), "bold rendered");
    assert((await page.$$(".msg.ai img")).length === 0, "model HTML is shown as text, never run");
    const call = modelLog.find((l) => l.path === "/v1/chat/completions");
    assert(call.auth === "Bearer good-key" && call.body.model === "test/model-a" && /Parent Plus/.test(call.body.messages[0].content), "model got key, model id and the product rules");
  });
  await check("ST-17", "Other models: conversations are saved and reopen after a reload", async () => {
    await page.reload(); await page.waitForSelector("#chatPane:not([hidden])");
    await page.waitForSelector(".msg.me:has-text('Write down my dark mode idea')", { timeout: 8000 });
    assert(await page.isVisible(".msg.ai:has-text('I read the README')"), "assistant reply restored");
    assert((await page.$$eval("#chatPick option", (o) => o.length)) >= 2, "conversation listed");
  });

  await check("ST-20", "decision cards: clickable options with one Recommended; the click goes back to the AI", async () => {
    await page.selectOption("#effortPick", "high");
    await page.fill("#ask", "Please decide where overdue fees go"); await page.keyboard.press("Enter");
    await page.waitForSelector(".ask .opt", { timeout: 8000 });
    assert(await page.isVisible(".ask .opt:has-text('Top of the Fees screen') .rec"), "Recommended badge on the right option");
    await page.click(".ask .opt:has-text('Top of the Fees screen')");
    await page.waitForSelector(".msg.ai:has-text('Noted: Top of the Fees screen')", { timeout: 8000 });
    assert(await page.isVisible(".ask.done .opt.chosen"), "chosen option marked, card locked");
    const last = modelLog.filter((l) => l.path === "/v1/chat/completions").at(-1);
    assert(last.body.reasoning_effort === "high", `thinking level sent: ${JSON.stringify(last.body.reasoning_effort)}`);
    await page.reload(); await page.waitForSelector(".ask.done .opt.chosen", { timeout: 8000 });
  });
  await check("ST-21", "model picker in the text box: switching model applies to the open chat (like Cursor)", async () => {
    await page.selectOption("#modelPick", "test/model-b"); await page.waitForTimeout(400);
    await page.fill("#ask", "Write down my dark mode idea again"); await page.keyboard.press("Enter");
    await page.waitForSelector(".toolcard.ask button:has-text('Allow')", { timeout: 8000 }); await page.click(".toolcard.ask button:has-text('Allow')");
    await page.waitForFunction(() => document.querySelectorAll(".msg.ai").length >= 3, null, { timeout: 8000 });
    const last = modelLog.filter((l) => l.path === "/v1/chat/completions").at(-1);
    assert(last.body.model === "test/model-b", `model used: ${last.body.model}`);
  });
  await check("ST-09", "no app link → Prototype tab is the default and shows the HTML prototype from git", async () => {
    const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage(); await p2.goto(`${base}/?k=${TOKEN}`);
    await p2.waitForSelector("#pane-proto.show");
    await p2.frameLocator("#protoFrame").locator("h1[data-ok='1']").waitFor({ timeout: 5000 });
    await p2.click("#tab-app"); assert(await p2.isVisible("#appEmpty"), "Real app offers to add a link");
    await ctx2.close();
    for (const path of ["/proto/parent-plus/..%2F..%2Fpackage.json", "/proto/parent-plus/%2e%2e%2fREADME.md", "/proto/parent-plus/../../package.json", "/proto/parent-plus/README.md", "/proto/nope/x.html"]) {
      const code = await rawGet(port, path, cookie.value); assert(code === "404", `${path} must be 404, got ${code}`);
    }
  });
  await check("ST-07", "set the app link from the Studio; it loads in the Real app tab", async () => {
    await page.click("#tab-app"); await page.click("#btnAppLink2");
    await page.fill("#uUrl", "javascript:alert(1)"); await page.click("#formUrl button[value=default]");
    await page.waitForFunction(() => /https/.test(document.querySelector("#uErr").textContent));
    await page.fill("#uUrl", `https://example.com/`); await page.click("#formUrl button[value=default]");
    await page.waitForFunction(() => document.querySelector("#appFrame").getAttribute("src") === "https://example.com/", null, { timeout: 5000 });
    assert(JSON.parse(readFileSync(join(home, "products.json"))).products[0].productionUrl === "https://example.com/", "saved");
  });
  await check("ST-22", "Claude Code: model and thinking picker above the screen restarts it with the choice", async () => {
    await page.click(".eng[data-eng=claude]"); await page.waitForSelector("#tModel option[value=opus]", { state: "attached" });
    await page.selectOption("#tModel", "opus"); await page.selectOption("#tEffort", "high"); await page.click("#tApply");
    await waitTerm(/CLAUDE ready \(mode=continue, product=Parent Plus\) model=opus effort=high/);
    await page.click(".eng[data-eng=codex]"); await page.waitForSelector("#tModel option[value=__other]", { state: "attached" });
    await page.selectOption("#tModel", "__other"); await page.fill("#tModelFree", "gpt-5.5"); await page.click("#tApply");
    await waitTerm(/CODEX ready \(mode=continue, product=Parent Plus\) model=gpt-5.5/);
    await page.click(".eng[data-eng=other]");
  });
  await check("ST-23", "Team table: each AI Org agent gets a model, reviewers differ from the builder, override works", async () => {
    await page.click("#tab-agents"); await page.waitForSelector("#team select[data-slug=dev-coder]", { timeout: 10000 });
    const auto = await page.$$eval("#team select", (s) => Object.fromEntries(s.map((x) => [x.dataset.slug, x.options[0].textContent])));
    assert(auto["dev-coder"] && auto["rex-reviewer"] && auto["dev-coder"] !== auto["rex-reviewer"], `dev vs rex: ${auto["dev-coder"]} / ${auto["rex-reviewer"]}`);
    await page.selectOption("#team select[data-slug=maya-ai-pm]", "free:mistral");
    await page.waitForFunction(() => document.querySelector("#team select[data-slug=maya-ai-pm]").value === "free:mistral", null, { timeout: 8000 });
    const saved = JSON.parse(readFileSync(join(home, "team.json"))); assert(saved["parent-plus"].overrides["maya-ai-pm"] === "free:mistral", "override saved");
  });
  await check("ST-10", "Agents tab shows the live board from GitHub", async () => {
    await page.click("#tab-agents");
    await page.waitForSelector("#tracks .trk:not(.head)", { timeout: 8000 });
    const rows = await page.$$eval("#tracks .trk:not(.head) .name", (n) => n.map((x) => x.innerText));
    assert(rows.some((r) => /overdue fees/i.test(r) && /Quinn, tester/.test(r)), `fees row with Quinn: ${rows.join(" | ")}`);
    assert(rows.some((r) => /shipped/.test(r)), "shipped row");
    assert((await page.$$("#tracks .st.agent")).length >= 1, "animated 'agent working' cell");
    assert((await page.$$("#feed a")).length >= 3, "feed");
    assert(await page.isHidden("#noAiOrg"), "AI Org detected");
  });
  await check("ST-12", "GitHub down → clear message, rest keeps working; recovers", async () => {
    writeFileSync(failFlag, "1");
    await page.waitForFunction(() => /could not refresh/.test(document.querySelector("#boardStatus").textContent), null, { timeout: 8000 });
    assert((await page.$$("#tracks .trk:not(.head)")).length > 0, "last board kept");
    rmSync(failFlag);
    await page.waitForFunction(() => /Live from GitHub/.test(document.querySelector("#boardStatus").textContent), null, { timeout: 8000 });
  });
  await check("ST-18", "Add product: bad input is explained; a real repo is copied and selectable", async () => {
    await page.click("#btnAddProduct"); await page.fill("#fRepo", "not a repo"); await page.click("#fAdd");
    await page.waitForFunction(() => /owner\/repo/.test(document.querySelector("#fErr").textContent), null, { timeout: 8000 });
    await page.fill("#fRepo", "https://github.com/acme/Demo-App"); await page.fill("#fUrl", "https://demo.example.com"); await page.click("#fAdd");
    await page.waitForFunction(() => [...document.querySelectorAll("#productPick option")].some((o) => o.textContent === "Demo-App"), null, { timeout: 15000 });
    assert((await page.$eval("#productPick", (s) => s.selectedOptions[0].textContent)) === "Demo-App", "new product selected");
    assert(existsSync(join(tmp, "ws/demo-app/.git")), "repo copied into the Studio workspace");
    await page.click(".eng[data-eng=claude]"); await waitTerm(/CLAUDE ready \(mode=new, product=Demo-App\)/);
    await page.selectOption("#productPick", "parent-plus"); await waitTerm(/CLAUDE heard|CLAUDE ready/);
  });
  await check("ST-14", "keyboard: tabs reachable with arrow keys, visible focus", async () => {
    await page.focus("#tab-agents"); await page.keyboard.press("ArrowRight");
    assert((await page.getAttribute("#tab-app", "aria-selected")) === "true", "arrow moves to next tab");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert(outline && outline !== "none", `focus outline: ${outline}`);
  });
  await check("—", "no browser errors", async () => assert(!errors.length, errors.join(" | ")));
  if (process.env.SHOT) { await page.click(".eng[data-eng=other]"); await page.click("#tab-agents"); await page.waitForTimeout(600); await page.screenshot({ path: process.env.SHOT }); }
  await ctx.close();
} finally { await browser.close(); srv.kill("SIGTERM"); model.close(); }
console.log(results.join("\n"));
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) { console.log("--- server log ---\n" + srvOut.slice(-2500)); process.exit(1); }
rmSync(tmp, { recursive: true, force: true });
