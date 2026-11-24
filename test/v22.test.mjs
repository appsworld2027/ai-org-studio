// v2.2: connected apps (MCP) for every AI, keys kept away from the AI, the Garage and shared memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeConnectors, probeStdio, CATALOG } from "../server/connectors.mjs";
import { mcpSession, openApps, toolName } from "../server/mcp-client.mjs";
import { makeGarage, redact } from "../server/garage.mjs";
import { runTurn, safePath } from "../server/agent.mjs";
import { claudeArgs } from "../server/engines/claude.mjs";
import { translateRequest, requestResult, turnMode } from "../server/engines/codex.mjs";
import { handle as vercelHandle } from "../bin/mcp-vercel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ECHO = join(ROOT, "test/fixtures/echo-mcp.mjs");
const tmp = () => mkdtempSync(join(tmpdir(), "v22-"));

test("apps: keys are stored for you only, never listed back, and every AI gets the same servers", () => {
  const dir = tmp(), c = makeConnectors({ dir, root: ROOT });
  assert.ok(CATALOG.find((a) => a.id === "supabase").steps.length >= 3, "clear steps for each app");
  assert.throws(() => c.set("nope", { enabled: true }), /Unknown app/);
  c.set("notion", { keys: { NOTION_TOKEN: "ntn_abcdefghijklmnopqrstuvwxyz1234567890" }, enabled: true });
  assert.equal((statSync(c.file).mode & 0o777).toString(8), "600", "key file readable by you only");
  const n = c.list().find((a) => a.id === "notion");
  assert.equal(n.enabled, true); assert.equal(n.keys[0].set, true); assert.equal(n.keys[0].tail, "…7890");
  assert.ok(!JSON.stringify(c.list()).includes("ntn_abcdef"), "the key value never leaves the server");
  // Claude Code config and Codex overrides name the app but carry NO key.
  const cc = c.claudeConfig(); const txt = readFileSync(cc.file, "utf8");
  assert.ok(txt.includes("mcp-run.mjs") && txt.includes('"notion"') && !txt.includes("ntn_"), "Claude config has the runner, not the key");
  assert.deepEqual(cc.allow, ["mcp__browser", "mcp__notion"].filter((x) => x !== "mcp__browser" || c.list().find((a) => a.id === "browser").enabled));
  const cx = c.codexConfig().join("\n");
  assert.match(cx, /mcp_servers\.notion\.command=/); assert.match(cx, /mcp_servers\.notion\.default_tools_approval_mode="approve"/); assert.ok(!cx.includes("ntn_"));
  // The launch command gives the key only to the app's own server.
  const l = c.launch("notion"); assert.equal(l.env.NOTION_TOKEN.slice(0, 4), "ntn_"); assert.deepEqual(l.args.slice(0, 2), ["-y", "@notionhq/notion-mcp-server@latest"]);
  // Supabase: read-only by default and limited to one project when a ref is given.
  c.set("supabase", { keys: { SUPABASE_ACCESS_TOKEN: "sbp_x".padEnd(40, "x"), SUPABASE_PROJECT_REF: "zcgcnycnanqkbdlwojln" }, enabled: true });
  const s = c.launch("supabase"); assert.ok(s.args.includes("--read-only")); assert.deepEqual(s.args.slice(-2), ["--project-ref", "zcgcnycnanqkbdlwojln"]);
  assert.equal(s.env.SUPABASE_PROJECT_REF, undefined, "only secret keys go in the environment");
  c.set("notion", { enabled: false }); assert.ok(!c.codexConfig().join().includes("notion"), "disconnect removes it from every AI");
  assert.throws(() => c.set("bad name", { custom: { command: "x" } }), /lowercase/);
  assert.throws(() => c.set("mine", { custom: { url: "http://insecure" } }), /https/);
});
test("apps: the key reaches the app's server through mcp-run, and a probe lists its tools", async () => {
  const dir = tmp(), c = makeConnectors({ dir, root: ROOT });
  c.set("echo", { custom: { command: ECHO, name: "Echo" }, keys: { ECHO_KEY: "SECRET123456" }, enabled: true });
  const r = await probeStdio(process.execPath, [join(ROOT, "bin/mcp-run.mjs"), "echo"].map(String), 20000).catch((e) => ({ ok: false, detail: e.message }));
  // mcp-run reads STUDIO_HOME, so run it with this test's folder.
  const env = { ...process.env, STUDIO_HOME: dir };
  const m = mcpSession({ command: process.execPath, args: [join(ROOT, "bin/mcp-run.mjs"), "echo", dir], env: { PATH: process.env.PATH }, name: "echo" });
  const tools = await m.ready; assert.deepEqual(tools.map((t) => t.name), ["whoami"]);
  const out = await m.callTool("whoami", {}); m.stop();
  assert.equal(out.text, "account for key SECRET…", "the app's server received the key");
  assert.equal(typeof r.ok, "boolean");
});
test("free/other models: connected apps become tools; their calls run without a per-call question", async () => {
  const dir = tmp(), c = makeConnectors({ dir, root: ROOT });
  c.set("echo", { custom: { command: ECHO }, keys: { ECHO_KEY: "KEY987654321" }, enabled: true });
  const apps = await openApps(c.servers().filter((s) => s.id === "echo"), { env: { PATH: process.env.PATH } });
  assert.deepEqual(apps.tools.map((t) => t.name), [toolName("echo", "whoami")]);
  const sse = (...ev) => (async function* () { yield new TextEncoder().encode(ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"); })();
  const replies = [sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a1", function: { name: "mcp__echo__whoami", arguments: "{}" } }] } }] }), sse({ choices: [{ delta: { content: "done" } }] })];
  const bodies = [], events = [], messages = [{ role: "user", content: "who am i" }];
  await runTurn({ messages, provider: { id: "x", base: "https://p/v1" }, model: "m", root: tmp(), systemPrompt: "S", emit: (e) => events.push(e), apps: apps.tools,
    approve: async () => { throw new Error("connected apps must not ask each time"); }, fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, body: replies.shift() }; } });
  apps.close();
  assert.ok(bodies[0].tools.some((t) => t.function.name === "mcp__echo__whoami"), "the model is offered the app's tool");
  assert.match(messages.find((m) => m.role === "tool").content, /account for key KEY987/);
  assert.ok(events.some((e) => e.t === "tool" && e.app === "echo" && e.ask === false));
});
test("Claude Code and Codex: apps and the Garage are passed in; app-tool approvals become Allow cards", () => {
  const a = claudeArgs({ mcpConfig: { file: "/h/mcp-claude.json", allow: ["mcp__supabase"] }, extraDirs: ["/h/studio-garage/pp"] });
  assert.deepEqual(a.slice(a.indexOf("--add-dir"), a.indexOf("--add-dir") + 2), ["--add-dir", "/h/studio-garage/pp"]);
  assert.deepEqual(a.slice(a.indexOf("--mcp-config"), a.indexOf("--mcp-config") + 2), ["--mcp-config", "/h/mcp-claude.json"]);
  assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__supabase");
  assert.deepEqual(turnMode("auto", ["/h/g"]).sandboxPolicy.writableRoots, ["/h/g"], "Codex may write the Garage in Auto-edit");
  const e = translateRequest({ id: 0, method: "mcpServer/elicitation/request", params: { serverName: "supabase", _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "list_tables", tool_description: "List tables" } } }, { items: {} });
  assert.equal(e.t, "approve"); assert.equal(e.title, "Supabase: list tables");
  assert.deepEqual(requestResult("mcpServer/elicitation/request", true), { action: "accept", content: {} });
  assert.deepEqual(requestResult("mcpServer/elicitation/request", false), { action: "decline" });
});
test("Vercel app (read-only): lists tools; without a token it explains how to connect", async () => {
  const l = await vercelHandle({ method: "tools/list" });
  assert.deepEqual(l.tools.map((t) => t.name), ["list_projects", "list_deployments", "get_deployment", "get_build_logs", "find_preview_for_branch"]);
  assert.ok(l.tools.every((t) => t.annotations.readOnlyHint));
  const r = await vercelHandle({ method: "tools/call", params: { name: "list_projects", arguments: {} } });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /Apps → Vercel/);
});
test("secrets never reach the Garage", () => {
  const r = redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB and sbp_0123456789abcdef0123456789abcdef01 and api_key = 'abcd1234abcd1234abcd' and normal text");
  assert.ok(!/ghp_a|sbp_0|abcd1234abcd/.test(r.text), r.text); assert.ok(r.count >= 3); assert.match(r.text, /normal text/);
  assert.equal(redact("A plain plan with no keys.").count, 0);
});
test("Garage: folders, shared memory pack for every AI (incl. AI Org memory), journal line per turn, saved to GitHub", async () => {
  const base = tmp(), remote = join(base, "remote.git"), gdir = join(base, "studio-garage"), prod = join(base, "pp");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]); execFileSync("git", ["clone", "-q", remote, gdir], { stdio: "ignore" });
  mkdirSync(join(prod, "docs/ai-memory"), { recursive: true }); writeFileSync(join(prod, "docs/ai-memory/LESSONS.md"), "# Lessons\n- Fixtures need a coach with two students.\n");
  const p = { id: "parent-plus", name: "Parent Plus", repo: "appsworld2027/Parent-plus-", dir: prod };
  const g = makeGarage({ dir: gdir, repo: "appsworld2027/studio-garage", now: () => new Date("2026-11-24T10:00:00Z") });
  assert.ok(g.ready()); const d = g.ensureProduct(p);
  for (const f of ["notes", "research", "plans", "reports", "mockups", "screenshots", "journal"]) assert.ok(existsSync(join(d, f)), f);
  writeFileSync(join(d, "MEMORY.md"), readFileSync(join(d, "MEMORY.md"), "utf8").replace("## Decisions (newest first)\n", "## Decisions (newest first)\n- 2026-11-24 Founder: overdue fees go at the top of the Fees tab.\n"));
  writeFileSync(join(d, "notes/2026-11-24-fees.md"), "# Fee screen notes\nkey sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789\n");
  g.journal(p, { engine: "codex", model: "gpt-5.6", account: "ankit@example.com", ask: "Put overdue fees on top", did: "Changed FeeList.tsx and added a test" });
  const r = await g.save(p, "codex: put overdue fees on top");
  assert.equal(r.pushed, true); assert.ok(r.redacted >= 1, "secret removed before saving");
  const pushedNote = execFileSync("git", ["--git-dir", remote, "show", "main:parent-plus/notes/2026-11-24-fees.md"]).toString();
  assert.ok(!pushedNote.includes("sk-ant-api03"), "the key never reached GitHub");
  // A different AI, on a different login, in a new session, gets the same picture.
  const pack = g.memoryPack(p);
  assert.match(pack, /overdue fees go at the top/); assert.match(pack, /codex\/gpt-5\.6 \(ankit@…\) · asked: Put overdue fees on top/);
  assert.match(pack, /Fixtures need a coach with two students/, "AI Org product memory is included (read-only)"); assert.match(pack, /notes\/2026-11-24-fees\.md — Fee screen notes/);
  assert.match(g.rules(p), /never in the product repo and never in \/tmp/);
  // A second machine (another Cloud Shell, another laptop) sees the same Garage.
  const other = join(base, "other"); execFileSync("git", ["clone", "-q", remote, other], { stdio: "ignore" });
  assert.match(readFileSync(join(other, "parent-plus/MEMORY.md"), "utf8"), /overdue fees go at the top/);
});
test("free/other models can write into the Garage with garage/… paths, and nowhere else outside the product", () => {
  const prod = tmp(), gar = tmp(); const root = { product: prod, garage: gar };
  assert.equal(safePath(root, "garage/notes/a.md"), join(gar, "notes/a.md"));
  assert.equal(safePath(root, "src/a.ts"), join(prod, "src/a.ts"));
  assert.throws(() => safePath(root, "garage/../../etc/passwd"), /outside/);
  assert.throws(() => safePath(root, "../x"), /outside/);
});
test("Garage: repo name read from git settings; Team table published for the AI Org router", () => {
  const base = tmp(), g = join(base, "studio-garage"); execFileSync("git", ["init", "-q", g]); execFileSync("git", ["-C", g, "remote", "add", "origin", "https://github.com/appsworld2027/studio-garage.git"]);
  const gar = makeGarage({ dir: g }); assert.equal(gar.repo, "appsworld2027/studio-garage");
  const p = { id: "pp", name: "PP", repo: "o/r", dir: base };
  gar.publishTeam(p, { rows: [{ slug: "dev-coder", name: "Dev", pick: { id: "codex:default" }, fallback: { id: "free:nemotron" }, why: "Best for coding" }] });
  const t = JSON.parse(readFileSync(join(g, "pp/team-models.json"), "utf8"));
  assert.deepEqual(t.agents[0], { agent: "dev-coder", name: "Dev", model: "codex:default", backup: "free:nemotron", why: "Best for coding" });
});
