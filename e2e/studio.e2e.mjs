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
import { startFakeModels } from "./fake/models.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const results = []; let failed = 0;
const check = async (id, name, fn) => { try { await fn(); results.push(`PASS ${id} ${name}`); } catch (e) { failed++; results.push(`FAIL ${id} ${name}: ${e.message.split("\n")[0]}`); } };
const assert = (c, m) => { if (!c) throw new Error(m); };
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const rawGet = (port, path, cookie) => new Promise((ok) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${cookie ? `Cookie: studio_key=${cookie}\r\n` : ""}Connection: close\r\n\r\n`)); let d = ""; s.on("data", (x) => (d += x)); s.on("end", () => ok(d.split(" ")[1])); });

// The whole test run lives next to the code so deterministic stand-in engines can access the temporary fixtures.
// Real products live in ~/studio-products, so real use is unaffected.
const tmp = mkdtempSync(join(ROOT, ".e2e-run-"));
const home = join(tmp, "studio-home"); mkdirSync(home);
// A real git repo stands in for the product (so prototypes come from git, as in real use).
const prod = join(tmp, "parent-plus"); mkdirSync(join(prod, "founders/prototypes"), { recursive: true });
writeFileSync(join(prod, "founders/prototypes/ParentPlus_Coach_Tutor_App.html"), readFileSync(join(ROOT, "e2e/product/founders/prototypes/ParentPlus_Coach_Tutor_App.html")));
writeFileSync(join(prod, "README.md"), "# Parent Plus\nCoach and parent app.\n");
mkdirSync(join(prod, ".ai-org"), { recursive: true });
writeFileSync(join(prod, ".ai-org", "manifest.json"), JSON.stringify({
  executionPolicy: { enabled: true, allowedEngines: ["free"], allowPaidFallback: false }
}));
const git = (...a) => execFileSync("git", ["-C", prod, ...a], { stdio: "ignore" });
git("init", "-q", "-b", "main"); git("add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
writeFileSync(join(home, "team.json"), JSON.stringify({ "parent-plus": { availability: { "free:gpt-oss-120b": true, "free:qwen-3.8-27b": true } } }));
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
    for (const d of chunks) res.write(`data: ${JSON.stringify({ model: "test/served-model", choices: [{ delta: d }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(modelPort, "127.0.0.1");

const port = await freePort();
const failFlag = join(tmp, "gh-down");
const fakeEngine = (name) => `printf '${name} ready (mode=%s, product=%s) model=%s effort=%s\\n' "$STUDIO_MODE" "$STUDIO_PRODUCT" "$STUDIO_MODEL" "$STUDIO_EFFORT"; while IFS= read -r line; do line=$(printf '%s' "$line" | sed -e 's/\\x1b\\[200~/<paste>/g' -e 's/\\x1b\\[201~/<\\/paste>/g'); printf '${name} heard: %s\\n' "$line"; printf '%s\\n' "$line" >> "$STUDIO_HEARD_FILE"; done`;
const TOKEN = "e2e-test-key-0123456789";
// CI always uses deterministic CLI stand-ins. A local diagnostic may opt into a real CLI explicitly; no paid model is called here.
const anthropicPort = await freePort(), openaiPort = await freePort();

const engineHome = join(tmp, "engine-home"); mkdirSync(join(engineHome, ".codex"), { recursive: true });
// The Garage: a local "GitHub" (bare repo) and its clone, as studio.sh / iter22 sets up for real.
const garageRemote = join(tmp, "garage.git"), garageDir = join(tmp, "studio-garage");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", garageRemote]); execFileSync("git", ["clone", "-q", garageRemote, garageDir], { stdio: "ignore" });
execFileSync("git", ["-C", garageDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"]); execFileSync("git", ["-C", garageDir, "push", "-q", "origin", "HEAD"]);
// The guard must see a verified private GitHub URL. Route only this test's
// exact fixture push/pull to the isolated bare repo, never the real network.
const gitShimDir = join(tmp, "git-shim");
mkdirSync(gitShimDir);
writeFileSync(join(gitShimDir, "git"), readFileSync(join(ROOT, "e2e/fake/git")), { mode: 0o755 });
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
execFileSync("git", ["-C", garageDir, "remote", "set-url", "origin", "https://github.com/example/studio-private-fixture.git"]);
const fakeModels = startFakeModels({ anthropicPort, openaiPort, projectDir: prod, garageDir: join(garageDir, "parent-plus") });
// No pre-trust here: the Studio itself must mark the product folder trusted for Claude Code and Codex.
const realClaude = process.env.STUDIO_REAL_CLAUDE || "", realCodex = process.env.STUDIO_REAL_CODEX || "";
const env = { ...process.env, PATH: gitShimDir + ":" + process.env.PATH, REAL_GIT: realGit, FAKE_GARAGE_ROOT: garageDir, FAKE_GARAGE_REMOTE: garageRemote, HOME: engineHome, ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropicPort}`, ANTHROPIC_API_KEY: "sk-ant-test", STUDIO_TEST_MODE: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", FAKE_OPENAI_KEY: "test",
  STUDIO_CLAUDE_BIN: realClaude || join(ROOT, "e2e/fake/claude"), STUDIO_CODEX_BIN: realCodex || join(ROOT, "e2e/fake/codex"),
  STUDIO_CODEX_CONFIG: ['model_provider="fake"', 'model_providers.fake.name="fake"', `model_providers.fake.base_url="http://127.0.0.1:${openaiPort}/v1"`, 'model_providers.fake.env_key="FAKE_OPENAI_KEY"', 'model_providers.fake.wire_api="responses"', 'model_providers.fake.supports_websockets=false', 'model="gpt-fake"'].join("\n"), STUDIO_HOME: home, STUDIO_GARAGE: garageDir, STUDIO_GARAGE_REPO: "appsworld2027/studio-garage", FAKE_GARAGE_DIR: join(garageDir, "parent-plus"), STUDIO_PORT: String(port), STUDIO_HOST: "127.0.0.1", STUDIO_TOKEN: TOKEN, STUDIO_GH: join(ROOT, "e2e/fake/gh"),
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
    const typed = await fetch(`${base}/?authuser=0?k=${TOKEN}`, { redirect: "manual" });
    assert(typed.status === 302 && /studio_key=/.test(typed.headers.get("set-cookie") || ""), `key typed after Cloud Shell's ?authuser=0 works: ${typed.status}`);
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
  await check("ST-01", "layout: product picker, three AI choices on the left, four tabs on the right", async () => {
    await page.waitForSelector(".eng[data-eng=claude]");
    assert((await page.$eval("#productPick", (s) => s.selectedOptions[0].textContent)) === "Parent Plus", "product shown");
    for (const n of ["Claude Code", "Codex", "Other models"]) assert(await page.isVisible(`.eng:has-text("${n}")`), `engine ${n}`);
    for (const t of ["Real app", "Prototype", "Agents", "Changes"]) assert(await page.isVisible(`.rtab:has-text("${t}")`), `tab ${t}`);
    assert(cookie && cookie.httpOnly && cookie.sameSite === "Strict", "HttpOnly SameSite=Strict cookie");
    assert(!page.url().includes("k="), "key removed from the address bar");
  });

  // Terminal text with wrapped lines joined (a narrow panel wraps long lines).
  const termText = () => page.evaluate(() => [...document.querySelectorAll("#term .xterm-rows > div")].map((r) => r.textContent.replace(/\s+$/, "")).join("\n").replace(/\n(?=\S)/g, (m, i, str) => (str.slice(Math.max(0, i - 1), i).match(/\S/) && false) ? "" : m) || "");
  const flat = async () => (await termText()).replace(/\n/g, "");
  const waitTerm = async (re, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = await termText(); if (re.test(t) || re.test(await flat())) return t; await page.waitForTimeout(150); } throw new Error(`terminal never showed ${re}; got: ${(await termText()).slice(-200)}`); };

  // The terminal is now an advanced view behind "Terminal view"; the default for Claude Code / Codex is the chat.
  const openTerm = async (eng) => { await page.click(`.eng[data-eng=${eng}]`); await page.waitForSelector("#ePane:not([hidden])"); await page.click("#eAdvanced"); await page.waitForSelector("#termPane:not([hidden])"); };
  await check("ST-02", "Claude Code terminal view (advanced) starts for this product and receives typing", async () => {
    assert(await page.isVisible("#ePane") && await page.isHidden("#termPane"), "Claude Code opens as a chat, not a terminal");
    await page.click("#eAdvanced"); await page.waitForSelector("#termPane:not([hidden])");
    await waitTerm(/CLAUDE ready \(mode=new, product=Parent Plus\)/);
    await page.click("#term"); await page.keyboard.type("what is next on the backlog"); await page.keyboard.press("Enter");
    await waitTerm(/CLAUDE heard: what is next on the backlog/);
  });
  await check("ST-03", "Codex screen starts; switching back keeps Claude's chat", async () => {
    await openTerm("codex"); await waitTerm(/CODEX ready/);
    await openTerm("claude"); await waitTerm(/CLAUDE heard: what is next on the backlog/);
  });
  await check("ST-06", "reload re-attaches; Continue last chat and Restart work", async () => {
    await page.reload(); await page.waitForSelector("#ePane:not([hidden])"); await page.click("#eAdvanced"); await waitTerm(/CLAUDE heard: what is next on the backlog/);
    await page.click("#btnContinue"); await waitTerm(/CLAUDE ready \(mode=continue/);
    await page.click("#btnRestart"); await waitTerm(/CLAUDE ready \(mode=new/);
  });

  const chatText = () => page.$eval("#eMsgs", (m) => m.innerText);
  await check("ST-25", "Claude Code chat: streams the reply, shows steps, asks before changing a file, clickable question, no terminal anywhere", async () => {
    await page.click(".eng[data-eng=claude]"); await page.waitForSelector("#ePane:not([hidden])");
    if (await page.isVisible("#termPane")) await page.click("#tBack");
    await page.waitForFunction(() => /Claude:|Not signed in/.test(document.querySelector("#eAcct").textContent), null, { timeout: 15000 });
    await page.click("#eNew");
    await page.fill("#eAsk", "Write down my dark mode idea");
    await page.evaluate(() => { const bin = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bin], "image.png", { type: "image/png" })); document.querySelector("#eAsk").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
    await page.waitForFunction(() => document.querySelectorAll("#eChips .chip:not(.up)").length === 1, null, { timeout: 8000 });
    await page.press("#eAsk", "Enter");
    await page.waitForSelector("#eMsgs .msg.me .attchip", { timeout: 8000 });
    await page.waitForSelector("#eMsgs .approve button:has-text('Allow')", { timeout: 20000 });
    assert(/dark mode/i.test(await chatText()), "reply text streamed into the chat");
    assert(await page.isVisible("#eMsgs .msg.ai b"), "markdown bold rendered");
    assert(/Allow Claude Code to change files\?/.test(await chatText()), "plain-language permission card");
    assert(!existsSync(join(prod, "docs/claude-idea.md")), "nothing written before Allow");
    await page.click("#eMsgs .approve button:has-text('Allow')");
    await page.waitForSelector("#eMsgs .ask .opt", { timeout: 20000 });
    assert(readFileSync(join(prod, "docs/claude-idea.md"), "utf8").includes("Dark mode"), "file written after Allow");
    assert(await page.isVisible("#eMsgs .ask .opt:has-text('Top of Fees') .rec"), "Recommended badge");
    await page.click("#eMsgs .ask .opt:has-text('Top of Fees')");
    await page.waitForFunction(() => /noted your choice/.test(document.querySelector("#eMsgs").innerText), null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector("#eActivity").hidden, null, { timeout: 10000 });
    assert(await page.isVisible("#eMsgs .steps .step.done"), "step card marked done");
    assert(/Create docs\/claude-idea\.md/.test(await chatText()), "step says what changed in plain words");
    const t = await chatText();
    assert(!/[$❯›]\s|\x1b|for shortcuts|shift\+tab/i.test(t), `no terminal artefacts in the chat: ${t.slice(0, 200)}`);
    assert(fakeModels.log.anthropic.some((l) => /dark mode idea/.test(l.all) && /"type":"image"/.test(l.all)), "the pasted image reached Claude as an image");
  });
  await check("ST-26", "Claude Code chat survives a reload: same conversation, answered cards stay answered", async () => {
    await page.reload(); await page.waitForSelector("#ePane:not([hidden])");
    await page.waitForSelector("#eMsgs .msg.me", { timeout: 10000 });
    assert(/noted your choice/.test(await chatText()), "assistant reply restored");
    assert(await page.isVisible("#eMsgs .approve.answered") && await page.isVisible("#eMsgs .ask.done .opt.chosen"), "cards restored as answered");
  });
  await check("ST-27", "Codex chat: same experience; model picker from Codex; asks before running a command", async () => {
    await page.click(".eng[data-eng=codex]"); await page.waitForSelector("#ePane:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#eModel option").length >= 1, null, { timeout: 15000 });
    await page.click("#eNew"); await page.fill("#eAsk", "Create the file please"); await page.press("#eAsk", "Enter");
    await page.waitForSelector("#eMsgs .approve button:has-text('Allow')", { timeout: 25000 });
    assert(/Allow Codex to run this\?/.test(await chatText()), "plain-language run permission");
    await page.click("#eMsgs .approve button:has-text('Allow')");
    await page.waitForSelector("#eMsgs .msg.ai b:has-text('made-by-codex.txt')", { timeout: 30000 });
    assert(existsSync(join(prod, "made-by-codex.txt")), "command ran after Allow");
    assert(await page.isVisible("#eMsgs .steps .step.done"), "command step marked done");
  });
  await check("ST-29", "Claude Code v2.1: Auto-edit mode, thinking block, plan checklist, plain step labels, steps fold into one line, copy code, memory meter", async () => {
    await page.click(".eng[data-eng=claude]"); await page.waitForSelector("#ePane:not([hidden])");
    await page.click("#eNew"); await page.selectOption("#eMode", "auto");
    await page.fill("#eAsk", "PLANCHECK summarise the README into docs/summary.md"); await page.press("#eAsk", "Enter");
    await page.waitForSelector("#ePlan:not([hidden]) .planlist li", { state: "attached", timeout: 20000 });
    await page.waitForFunction(() => /Summary written/.test(document.querySelector("#eMsgs").innerText), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("#eActivity").hidden, null, { timeout: 10000 });
    assert(!(await page.$("#eMsgs .approve:not(.answered)")), "Auto-edit: no Allow card for a file change inside the product");
    assert(readFileSync(join(prod, "docs/summary.md"), "utf8").includes("Coach"), "file written in auto-edit mode");
    assert(/2 of 2 done/.test(await page.textContent("#ePlan")), `plan checklist shows progress: ${await page.textContent("#ePlan")}`);
    assert(await page.isVisible("#eMsgs details.thinking"), "thinking shown as a collapsible block");
    assert(/Thought/.test(await page.textContent("#eMsgs details.thinking summary")), "thinking block says Thought…");
    const sums = await page.$$eval("#eMsgs .steps > summary", (n) => n.map((x) => x.textContent));
    assert(sums.some((t) => /Read 1 file/.test(t)) && sums.some((t) => /Changed 1 file/.test(t)), `group summaries in plain words: ${sums.join(" | ")}`);
    assert(await page.$eval("#eMsgs .steps:last-of-type", (d) => !d.open), "finished steps fold into one line");
    assert(/Read README\.md/.test(await page.$eval("#eMsgs", (m) => m.textContent)), "read step named by file");
    assert(!/TodoWrite|Bash\(|tool_use/.test(await chatText()), "no raw tool names");
    assert(await page.$("#eMsgs .msg.ai .md pre .copy"), "code block has a copy button");
    assert(/memory used/.test(await page.getAttribute("#eMeta .ctx", "aria-label")), `memory meter shown: ${await page.textContent("#eMeta")}`);
    const cut = await page.$$eval("#eComposer .pill", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 2).map((e) => e.id));
    assert(!cut.length, `composer pills are not cut off: ${cut.join(", ")}`);
    assert(await page.$eval("#ePlan details", (d) => !d.open), "a finished plan folds to one line");
    if (process.env.STUDIO_SHOTS) { await page.$$eval("#eMsgs .steps", (d) => d.forEach((x, i, a) => (x.open = i === a.length - 1))); await page.screenshot({ path: join(process.env.STUDIO_SHOTS, "v21-claude.png") }); }
    await page.selectOption("#eMode", "ask");
  });
  await check("ST-30", "Codex v2.1: reading runs without asking, labelled by file, with its output; plan checklist; memory meter", async () => {
    await page.click(".eng[data-eng=codex]"); await page.waitForSelector("#ePane:not([hidden])");
    await page.click("#eNew"); await page.selectOption("#eMode", "ask");
    await page.fill("#eAsk", "LOOKAROUND what does the README say?"); await page.press("#eAsk", "Enter");
    await page.waitForFunction(() => /coach and parent app/i.test(document.querySelector("#eMsgs .msg.ai:last-of-type")?.innerText || ""), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector("#eActivity").hidden, null, { timeout: 10000 });
    assert(!(await page.$("#eMsgs .approve:not(.answered)")), "reading needed no Allow");
    const all = await page.$eval("#eMsgs", (m) => m.textContent);
    if (!/Read README\.md/.test(all)) { const list = await page.evaluate(() => fetch("/api/products/parent-plus/chats").then((r) => r.json())); const c = list.chats.find((x) => x.engine === "codex"); const full = await page.evaluate((id) => fetch(`/api/products/parent-plus/chats/${id}`).then((r) => r.json()), c.id); console.log("DEBUG codex events:", JSON.stringify(full.events).slice(0, 3000)); console.log("DEBUG openai:", JSON.stringify(fakeModels.log.openai.slice(-4).map((l) => l.input.slice(-700)))); }
    assert(/Read README\.md/.test(all), `command shown as what it did: ${all.slice(0, 300)}`);
    assert(!/\/bin\/bash -lc/.test(all), "no raw shell wrapper");
    const out = await page.$eval("#eMsgs .step[data-kind=read] .res pre", (p) => p.textContent).catch(() => "");
    assert(/Coach and parent app/.test(out), `command output kept: ${out}`);
    // Real Codex only offers its plan tool to OpenAI's own models, so the checklist is checked with the recorded stand-in.
    if (!realCodex) assert(/Read the README/.test(await page.textContent("#ePlan")), `plan checklist: ${await page.textContent("#ePlan")}`);
    assert(/memory used/.test(await page.getAttribute("#eMeta .ctx", "aria-label")), "memory meter");
    if (process.env.STUDIO_SHOTS) await page.screenshot({ path: join(process.env.STUDIO_SHOTS, "v21-codex.png") });
  });
  await check("ST-31", "@ mentions: typing @ lists the product's files; picking one inserts it", async () => {
    await page.fill("#eAsk", ""); await page.type("#eAsk", "look at @READ");
    await page.waitForSelector("#eMention:not([hidden]) .mitem", { timeout: 8000 });
    assert(/README\.md/.test(await page.textContent("#eMention")), "README listed");
    await page.press("#eAsk", "Enter");
    assert((await page.inputValue("#eAsk")) === "look at @README.md ", `inserted: ${await page.inputValue("#eAsk")}`);
    assert(await page.isHidden("#eMention"), "list closes");
    await page.fill("#eAsk", "");
  });
  await check("ST-32", "Changes tab: lists the files the AI changed, with a readable diff", async () => {
    await page.click("#tab-changes");
    await page.waitForSelector("#changesList .chfile", { timeout: 8000 });
    const names = await page.$$eval("#changesList .chp", (n) => n.map((x) => x.textContent));
    assert(names.includes("docs/summary.md") && names.includes("made-by-codex.txt"), `changed files: ${names.join(", ")}`);
    assert(!names.some((n) => n.startsWith(".studio-uploads")), "attachments are not listed as changes");
    await page.click('#changesList .chfile[data-path="docs/summary.md"]');
    await page.waitForSelector("#changesDiff:not([hidden]) .add", { timeout: 5000 });
    assert(/\+# Summary/.test(await page.textContent("#changesDiff")), "diff shows the new lines");
    assert(/\d/.test(await page.textContent("#changesBadge")), "badge counts changes");
    if (process.env.STUDIO_SHOTS) await page.screenshot({ path: join(process.env.STUDIO_SHOTS, "v21-changes.png") });
    await page.click("#tab-app");
  });
  await check("ST-33", "Apps: connect an app once (key never shown again); Claude Code uses it without asking and saves a note in the Garage", async () => {
    await page.click("#btnApps"); await page.waitForSelector("#dlgApps[open] .appcard[data-app=supabase]");
    assert(/Supabase/.test(await page.textContent("#appList")) && /Vercel/.test(await page.textContent("#appList")), "catalog listed");
    await page.click(".appcard[data-app=notion] summary");
    assert(/notion\.so\/profile\/integrations/.test(await page.textContent(".appcard[data-app=notion]")), "clear steps where to get the key");
    // A custom MCP server (the test 'echo' app) with a key.
    await page.click("details.custom summary"); await page.fill("#cId", "echo"); await page.fill("#cCmd", `${process.execPath} ${join(ROOT, "test/fixtures/echo-mcp.mjs")}`);
    await page.fill("#cKeyName", "ECHO_KEY"); await page.fill("#cKeyVal", "KEYABC123XYZ"); await page.click("#cAdd");
    await page.waitForSelector('.appcard[data-app=echo] .appst.on', { timeout: 30000 });
    if (process.env.STUDIO_SHOTS) { await page.click(".appcard[data-app=supabase] summary"); await page.screenshot({ path: join(process.env.STUDIO_SHOTS, "v22-apps.png") }); }
    const apps = await page.evaluate(() => fetch("/api/apps").then((r) => r.text()));
    assert(!apps.includes("KEYABC123XYZ") && apps.includes("…3XYZ"), "the key is never sent back to the page");
    await page.keyboard.press("Escape");
    await page.click(".eng[data-eng=claude]"); await page.waitForSelector("#ePane:not([hidden])"); await page.click("#eNew"); await page.selectOption("#eMode", "auto");
    await page.fill("#eAsk", "APPCHECK who am I in the echo app? note it in the Garage"); await page.press("#eAsk", "Enter");
    await page.waitForFunction(() => /Echo says/.test(document.querySelector("#eMsgs").innerText), null, { timeout: 40000 });
    assert(!(await page.$("#eMsgs .approve:not(.answered)")), "a connected app runs without asking each time");
    assert(/account for key KEYABC/.test(await chatText()), `the app got its key: ${(await chatText()).slice(-200)}`);
    assert(/Echo: whoami/.test(await page.$eval("#eMsgs", (m) => m.textContent)), "app step named in plain words");
    await page.waitForFunction(() => document.querySelector("#eActivity").hidden, null, { timeout: 10000 });
  });
  await check("ST-34", "Garage: AI-made files and a journal line are saved to GitHub automatically; secrets are removed; shown in the Garage tab", async () => {
    const t0 = Date.now(); let log = "";
    while (Date.now() - t0 < 15000) { log = execFileSync("git", ["--git-dir", garageRemote, "log", "--oneline", "main"]).toString(); if (/claude: APPCHECK/.test(log)) break; await page.waitForTimeout(400); }
    assert(/claude: APPCHECK/.test(log), `garage pushed after the reply: ${log}`);
    const files = execFileSync("git", ["--git-dir", garageRemote, "ls-tree", "-r", "--name-only", "main"]).toString();
    assert(files.includes("parent-plus/notes/2026-11-24-app-check.md") && files.includes("parent-plus/MEMORY.md") && /parent-plus\/journal\/\d{4}-\d{2}\.md/.test(files), files);
    const journal = execFileSync("git", ["--git-dir", garageRemote, "show", `main:parent-plus/journal/${new Date().toISOString().slice(0, 7)}.md`]).toString();
    assert(/· claude[^·]*· asked: APPCHECK who am I/.test(journal), journal);
    await page.click("#tab-garage"); await page.waitForSelector("#garageList .chfile", { timeout: 8000 });
    assert(/notes\/2026-11-24-app-check\.md/.test(await page.textContent("#garageList")), "Garage tab lists the note");
    await page.click('#garageList .chfile[data-path="MEMORY.md"]'); await page.waitForSelector("#garageView:not([hidden]) .gmd");
    assert(/shared memory for every AI/.test(await page.textContent("#garageView")), "memory readable in the Studio");
    if (process.env.STUDIO_SHOTS) await page.screenshot({ path: join(process.env.STUDIO_SHOTS, "v22-garage.png") });
  });
  await check("ST-35", "Memory across AIs: Codex (another engine, another login) starts knowing what Claude did, and uses the same app", async () => {
    // Write a founder decision into the shared memory, as an AI would.
    const mem = join(garageDir, "parent-plus/MEMORY.md");
    writeFileSync(mem, readFileSync(mem, "utf8").replace("## Decisions (newest first)\n", "## Decisions (newest first)\n- 2026-11-24 Founder: overdue fees go at the top of the Fees tab.\n"));
    await page.click(".eng[data-eng=codex]"); await page.waitForSelector("#ePane:not([hidden])"); await page.click("#eNew"); await page.selectOption("#eMode", "ask");
    await page.fill("#eAsk", "APPCHECK who am I in the echo app?"); await page.press("#eAsk", "Enter");
    await page.waitForFunction(() => /Echo says/.test(document.querySelector("#eMsgs").innerText), null, { timeout: 40000 });
    assert(!(await page.$("#eMsgs .approve:not(.answered)")), "Codex: connected app pre-approved");
    assert(/account for key KEYABC/.test(await chatText()), "Codex reached the app with its key");
    const sent = fakeModels.log.openai.filter((l) => /APPCHECK/.test(l.input)).map((l) => l.instructionsAll || "").join("");
    assert(/overdue fees go at the top/.test(sent) && /APPCHECK who am I in the echo app\? note it in the Garage/.test(sent), "Codex was given the shared memory and the journal of Claude's turn");
  });
  await check("ST-36", "Flag issue: from the test screen, the description and the page address go to the AI", async () => {
    await page.click("#tab-proto"); await page.click("#btnFlag"); await page.waitForSelector("#dlgFlag[open]");
    await page.fill("#flagText", "The Save button does nothing"); await page.click("#formFlag button.primary");
    await page.waitForFunction(() => /Issue flagged from the test screen/.test(document.querySelector("#eMsgs").innerText), null, { timeout: 15000 });
    assert(/Page: the HTML prototype ParentPlus_Coach_Tutor_App\.html/.test(await chatText()), "page named");
    await page.waitForFunction(() => document.querySelector("#eActivity").hidden || /reconnect/.test(document.querySelector("#eActivity").textContent), null, { timeout: 30000 }).catch(() => {});
  });
  await check("ST-37", "Connection drops (laptop sleeps, tunnel restarts): the chat reconnects by itself and shows the conversation again", async () => {
    const before = await chatText();
    // Drop the connection the way a network change does: the server side goes away (here: the page's socket is closed).
    const closed = await page.evaluate(() => window.__studioEchat?.dropConnection?.());
    assert(closed, "connection dropped");
    await page.waitForFunction(() => /reconnecting/.test(document.querySelector("#eActivity").textContent), null, { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector("#eActivity").classList.contains("offline"), null, { timeout: 15000 });
    assert((await chatText()).includes("Issue flagged from the test screen") && before.length > 0, "conversation shown again after reconnect");
  });
  await check("ST-38", "Web link: a tunnel address saved by studio.sh is accepted for the key link and the chat; other addresses are not", async () => {
    writeFileSync(join(home, "web-url"), "https://happy-test-words.trycloudflare.com\n");
    const up = (origin) => new Promise((ok) => { const s = net.connect(port, "127.0.0.1", () => s.write(`GET /pty?product=parent-plus&engine=claude HTTP/1.1\r\nHost: happy-test-words.trycloudflare.com\r\nCookie: studio_key=${TOKEN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`)); s.on("data", (d) => { ok(d.toString().split("\r\n")[0]); s.destroy(); }); });
    assert(/101/.test(await up("https://happy-test-words.trycloudflare.com")), "tunnel origin accepted");
    assert(/401|403/.test(await up("https://other-words.trycloudflare.com")), "another tunnel refused");
    rmSync(join(home, "web-url"));
  });
  await check("ST-39", "Phone: the Studio fits a phone screen (chat on top, test screen below, tabs scroll)", async () => {
    const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await m.addCookies([{ name: "studio_key", value: TOKEN, url: base }]); const ph = await m.newPage(); await ph.goto(base);
    await ph.waitForSelector("#ePane:not([hidden]), #chatPane:not([hidden])");
    const w = await ph.evaluate(() => document.documentElement.scrollWidth); assert(w <= 392, `no sideways scrolling: ${w}px`);
    assert(await ph.isVisible("#eSend, #btnSend") && await ph.isVisible("#tab-app"), "composer and tabs visible");
    await m.close();
  });
  await check("ST-28", "sign-in status: shows who is signed in or offers the official sign-in", async () => {
    const a = await page.evaluate(() => fetch("/api/engines/claude/account").then((r) => r.json()));
    assert(typeof a.signedIn === "boolean", `claude account: ${JSON.stringify(a)}`);
    const x = await page.evaluate(() => fetch("/api/engines/codex/account").then((r) => r.json()));
    assert(/Claude: test@example\.com|Not signed in/.test(await page.textContent("#eAcct")) || /ChatGPT/.test(await page.textContent("#eAcct")), "account shown in the chat bar");
    assert(typeof x.signedIn === "boolean", `codex account: ${JSON.stringify(x)}`);
  });
  await check("ST-15", "Other models: add a custom model server and key (key never returned to the page)", async () => {
    await page.click(".eng[data-eng=other]"); await page.waitForSelector("#chatPane:not([hidden])");
    await page.click("#btnKeys"); await page.selectOption("#kProvider", "custom");
    await page.fill("#kBase", `http://127.0.0.1:${modelPort}/v1`); await page.fill("#kKey", "bad-key"); await page.click("#kSave");
    try {
      await page.waitForFunction(() => /rejected/.test(document.querySelector("#kStatus").textContent), null, { timeout: 8000 });
    } catch (error) {
      const status = await page.locator("#kStatus").textContent().catch(() => "<missing>");
      throw new Error(`custom provider rejection diagnostic: status=${status}; testMode=${env.STUDIO_TEST_MODE}; modelPort=${modelPort}; modelLog=${JSON.stringify(modelLog)}; server=${srvOut.slice(-1600)}; wait=${error.message}`);
    }
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
    await openTerm("claude"); await page.waitForSelector("#tModel option[value=opus]", { state: "attached" });
    await page.selectOption("#tModel", "opus"); await page.selectOption("#tEffort", "high"); await page.click("#tApply");
    await waitTerm(/CLAUDE ready \(mode=continue, product=Parent Plus\) model=opus effort=high/);
    await openTerm("codex"); await page.waitForSelector("#tModel option[value=__other]", { state: "attached" });
    await page.selectOption("#tModel", "__other"); await page.fill("#tModelFree", "gpt-5.5"); await page.click("#tApply");
    await waitTerm(/CODEX ready \(mode=continue, product=Parent Plus\) model=gpt-5.5/);
    await page.click(".eng[data-eng=other]");
  });
  await check("ST-23", "Team table: each AI Org agent gets a model, reviewers differ from the builder, override works", async () => {
    await page.click("#tab-agents");
    await page.waitForFunction(() => ["dev-coder", "rex-reviewer"].every(slug => {
      const select = document.querySelector(`#team select[data-slug="${slug}"]`);
      return select && [...select.options].some(option => option.value.startsWith("free:"));
    }), null, { timeout: 10000 });
    const auto = await page.$$eval("#team select", (s) => Object.fromEntries(s.map((x) => [x.dataset.slug, x.options[0].textContent])));
    assert(auto["dev-coder"] && auto["rex-reviewer"] && auto["dev-coder"] !== auto["rex-reviewer"], `dev vs rex: ${auto["dev-coder"]} / ${auto["rex-reviewer"]}`);
    const options = await page.$$eval("#team select[data-slug=dev-coder] option", (o) => o.map((x) => x.textContent).join(" "));
    assert(/Groq free tier/i.test(options) && !/Claude|Codex|NVIDIA/i.test(options), `agent model choices must be Groq free-only: ${options}`);
    const rexChoices = await page.$$eval("#team select[data-slug=rex-reviewer] option", o => o.map(x => x.value));
    assert(rexChoices.includes("free:qwen-3.8-27b") && !rexChoices.includes("free:gpt-oss-120b"), "reviewer cannot choose builder model");
    const devChoices = await page.$$eval("#team select[data-slug=dev-coder] option", o => o.map(x => x.value));
    assert(devChoices.includes("free:gpt-oss-120b") && !devChoices.includes("free:qwen-3.8-27b"), "builder cannot choose reviewer model");
    await page.selectOption("#team select[data-slug=maya-ai-pm]", "free:qwen-3.8-27b");
    await page.waitForFunction(() => document.querySelector("#team select[data-slug=maya-ai-pm]").value === "free:qwen-3.8-27b", null, { timeout: 8000 });
    for (let i = 0; i < 40 && !JSON.parse(readFileSync(join(home, "team.json")))["parent-plus"]?.overrides?.["maya-ai-pm"]; i++) await page.waitForTimeout(150);
    const saved = JSON.parse(readFileSync(join(home, "team.json"))); assert(saved["parent-plus"].overrides["maya-ai-pm"] === "free:qwen-3.8-27b", "override saved");
  });
  await check("ST-10", "Agents tab shows the live board from GitHub", async () => {
    await page.click("#tab-agents");
    await page.waitForFunction(() => [...document.querySelectorAll("#tracks .trk:not(.head) .name")].some(node => /overdue fees/i.test(node.innerText) && /Quinn, test author/.test(node.innerText)), null, { timeout: 10000 });
    const rows = await page.$$eval("#tracks .trk:not(.head) .name", (n) => n.map((x) => x.innerText));
    assert(rows.some((r) => /overdue fees/i.test(r) && /Quinn, test author/.test(r)), `fees row with Quinn: ${rows.join(" | ")}`);
    assert(rows.some((r) => /shipped/.test(r)), "shipped row");
    assert((await page.$$("#tracks .st.agent")).length >= 1, "animated 'agent working' cell");
    assert((await page.$$("#feed a")).length >= 3, "feed");
    assert(await page.isHidden("#noAiOrg"), "AI Org detected");
    const modelCard = page.locator('.usage-card:has-text("test/served-model")').filter({ hasText: "Requested test/model-a" });
    const usage = await modelCard.innerText();
    assert(/Provider reported/.test(usage) && /Requested test\/model-a/.test(usage), "reported and requested models are distinguishable");
    assert(/Cache\s+\d+/.test(usage) && /Reasoning\s+Unknown/.test(usage), "measured cache and absent reasoning are distinguishable");
    const worker = await page.locator('.usage-card:has-text("fixture/worker-model")').innerText();
    assert(/Maya/.test(worker) && /Adapter reported/.test(worker) && /Input\s+32/.test(worker), "worker usage is attributed to its agent and adapter model");
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
    await openTerm("claude"); await waitTerm(/CLAUDE ready \(mode=new, product=Demo-App\)/);
    await page.selectOption("#productPick", "parent-plus"); await waitTerm(/CLAUDE heard|CLAUDE ready/);
  });
  await check("ST-40", "Founder Inbox dispatches an idempotent free-only task to Parent Plus", async () => {
    const inbox = page.locator("#founder-inbox-dialog");
    const privateFixture = JSON.parse(execFileSync(join(ROOT, "e2e/fake/gh"), ["api", "repos/appsworld2027/Parent-plus-"], { encoding: "utf8" }));
    assert(privateFixture.private === true, "fake GitHub metadata marks the registered Parent Plus fixture private");
    const gate = await page.evaluate(async () => {
      const response = await fetch("/api/founder-inbox");
      return { status: response.status, data: await response.json() };
    });
    assert(gate.status === 200 && gate.data.executionEnabled === true,
      `Founder Inbox gate: HTTP ${gate.status}; reason=${gate.data.executionReason || gate.data.message}; products=${JSON.stringify(gate.data.products)}`);
    let submittedPayload = null;
    const captureRequest = request => {
      if (request.url().endsWith("/api/founder-inbox") && request.method() === "POST") {
        try { submittedPayload = request.postDataJSON(); } catch {}
      }
    };
    page.on("request", captureRequest);
    try {
      await page.getByRole("button", { name: "Founder Inbox" }).click();
      await page.waitForFunction(() => document.querySelector("#founder-inbox-dialog")?.open, null, { timeout: 3000 });
      await page.waitForFunction(() => [...document.querySelectorAll("#founder-inbox-product option")].some(option => option.value === "parent-plus"), null, { timeout: 8000 });
      const parentPlusOptionCount = await inbox.locator('option[value="parent-plus"]').count();
      const inboxState = await inbox.innerText();
      assert(parentPlusOptionCount === 1, `only a GitHub-verified private product repository is dispatchable; options=${parentPlusOptionCount}; state=${inboxState}`);
      await inbox.getByLabel("Product repository").selectOption("parent-plus");
      await inbox.getByLabel("Task title").fill("E2E founder request");
      await inbox.getByLabel("Requested outcome").fill("Review the registration journey and report its top three edge cases.");
      await inbox.getByRole("button", { name: "Send to AI Org" }).click();
      await page.waitForFunction(() => document.querySelector("#founder-inbox-dialog")?.innerText.includes("Submitted to the canonical AI Org worker"), null, { timeout: 12000 });
      assert(await inbox.getByText("Open AI Org issue #500").isVisible(), "GitHub issue link displayed");
      assert(submittedPayload?.requestId, "the browser submitted a stable idempotency key");
      const firstIssues = JSON.parse(readFileSync(join(home, "fake-dispatched-issues.json"), "utf8"));
      assert(firstIssues.length === 1, "one GitHub issue created");
      assert(firstIssues[0].labels.some(label => label.name === "ai:discovery"), "AI discovery stage label applied");
      assert(firstIssues[0].body.toLowerCase().includes("approved free-only ai org router") && firstIssues[0].body.toLowerCase().includes("no paid model, paid api, paid fallback"), "free-only execution constraints persisted");
      const replay = await page.evaluate(async payload => {
        const response = await fetch("/api/founder-inbox", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        return { status: response.status, data: await response.json() };
      }, submittedPayload);
      assert(replay.status >= 200 && replay.status < 300, `same request ID retry accepted: HTTP ${replay.status}`);
      assert(replay.data.task.githubIssueNumber === 500, "retry resolves to the original GitHub issue");
      const replayedIssues = JSON.parse(readFileSync(join(home, "fake-dispatched-issues.json"), "utf8"));
      assert(replayedIssues.length === 1, "retry does not create a duplicate GitHub issue");
      const inboxText = await inbox.innerText();
      assert(!inboxText.includes("Run Maya") && !inboxText.includes("NVIDIA model"), "local synthetic pilot is not exposed as production dispatch");
    } finally {
      page.off("request", captureRequest);
      if (await inbox.count() && await inbox.evaluate(el => el.open).catch(() => false)) {
        await inbox.getByRole("button", { name: "Close" }).click().catch(() => {});
        await page.waitForFunction(() => !document.querySelector("#founder-inbox-dialog")?.open, null, { timeout: 3000 }).catch(() => {});
      }
    }
  });
  await check("ST-14", "keyboard: tabs reachable with arrow keys, visible focus", async () => {
    await page.focus("#tab-garage"); await page.keyboard.press("ArrowRight");
    assert((await page.getAttribute("#tab-app", "aria-selected")) === "true", "arrow moves to next tab");
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert(outline && outline !== "none", `focus outline: ${outline}`);
  });
  await check("—", "no browser errors", async () => assert(!errors.length, errors.join(" | ")));
  if (process.env.SHOT) { await page.click(".eng[data-eng=other]"); await page.click("#tab-agents"); await page.waitForTimeout(600); await page.screenshot({ path: process.env.SHOT }); }
  await ctx.close();
} finally { await browser.close(); srv.kill("SIGTERM"); model.close(); fakeModels.close(); }
console.log(results.join("\n"));
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) console.log("--- server log ---\n" + srvOut.slice(-2500));
// Clean up (always); a real Codex may still be writing a background cache for a moment, so never fail on clean-up.
await new Promise((r) => setTimeout(r, 1500));
try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (e) { console.log(`(left temp files: ${e.code})`); }
process.exit(failed ? 1 : 0);
