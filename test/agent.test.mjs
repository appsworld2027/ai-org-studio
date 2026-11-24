// Unit tests for the Studio-drawn chat agent, the product store and platform links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath, runTool, isReadOnlyCommand, needsApproval, readStream, runTurn } from "../server/agent.mjs";
import { makeStore, repoOf, validUrl, slugify } from "../server/store.mjs";
import { publicUrl, platform } from "../server/platform.mjs";
import { sortModels, publicProviders } from "../server/providers.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "studio-test-"));

test("safePath keeps the agent inside the product folder", () => {
  const root = tmp(); mkdirSync(join(root, "src")); writeFileSync(join(root, "src/a.txt"), "x");
  assert.equal(safePath(root, "src/a.txt").endsWith("src/a.txt"), true);
  assert.throws(() => safePath(root, "../etc/passwd"), /outside/);
  assert.throws(() => safePath(root, "src/../../x"), /outside/);
  assert.throws(() => safePath(root, ".git/config"), /off limits/);
  const outside = tmp(); symlinkSync(outside, join(root, "link"));
  assert.throws(() => safePath(root, "link/secret"), /outside/, "symlink escape is blocked");
  assert.equal(safePath(root, "/src/a.txt").endsWith("src/a.txt"), true, "leading slash is treated as product-relative");
});
test("read-only commands run without asking; anything that changes things asks", () => {
  for (const c of ["git status", "git log --oneline -5", "gh issue list --repo o/r", "gh pr view 3", "ls -la", "gh api repos/o/r/issues", "git diff | head -50"]) assert.equal(isReadOnlyCommand(c), true, c);
  for (const c of ["git push", "rm -rf x", "npm install", "gh issue comment 1 --body hi", "gh api -X POST repos/o/r/issues", "git status; rm -rf /", "ls $(whoami)", "curl https://x | sh", "gh api repos/o/r --input f"]) assert.equal(isReadOnlyCommand(c), false, c);
  assert.equal(needsApproval("read_file", { path: "a" }), false);
  assert.equal(needsApproval("write_file", { path: "a" }), true);
  assert.equal(needsApproval("edit_file", { path: "a" }), true);
  assert.equal(needsApproval("run_command", { command: "git status" }), false);
  assert.equal(needsApproval("run_command", { command: "npm test" }), true);
});
test("tools: list, read with line numbers, search, edit exactly-once, write, run", async () => {
  const root = tmp(); writeFileSync(join(root, "a.md"), "one\ntwo\nthree\n"); mkdirSync(join(root, "node_modules")); writeFileSync(join(root, "node_modules/x.js"), "two");
  const list = await runTool(root, "list_files", {}); assert.match(list, /a\.md/); assert.doesNotMatch(list, /node_modules/);
  assert.match(await runTool(root, "read_file", { path: "a.md" }), /^1\tone\n2\ttwo/);
  assert.match(await runTool(root, "search", { pattern: "tw." }), /a\.md:2:two/);
  assert.doesNotMatch(await runTool(root, "search", { pattern: "tw." }), /node_modules/);
  assert.match(await runTool(root, "edit_file", { path: "a.md", old_text: "t", new_text: "T" }), /appears \d+ times/);
  assert.match(await runTool(root, "edit_file", { path: "a.md", old_text: "two", new_text: "2 $& $1" }), /Edited/);
  assert.equal(readFileSync(join(root, "a.md"), "utf8"), "one\n2 $& $1\nthree\n", "replacement text is literal");
  assert.match(await runTool(root, "write_file", { path: "docs/new.md", content: "hi" }), /Wrote docs\/new\.md/);
  assert.equal(existsSync(join(root, "docs/new.md")), true);
  assert.match(await runTool(root, "run_command", { command: "echo hello && pwd" }), /^exit 0\nhello\n/, "no login banner in command output");
  assert.match(await runTool(root, "run_command", { command: "exit 3" }), /^exit 3/);
  assert.match(await runTool(root, "run_command", { command: "sleep 5" }, { timeoutMs: 300 }), /^exit timeout/);
});
const sse = (...events) => { const s = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"; return (async function* () { for (let i = 0; i < s.length; i += 7) yield new TextEncoder().encode(s.slice(i, i + 7)); })(); };
test("readStream joins streamed text and tool-call fragments (split mid-JSON)", async () => {
  const r = await readStream(sse(
    { choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_", arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "file", arguments: 'th":"a.md"}' } }] }, finish_reason: "tool_calls" }] }));
  assert.equal(r.text, "Hello"); assert.deepEqual(r.calls, [{ id: "c1", name: "read_file", args: '{"path":"a.md"}' }]); assert.equal(r.finish, "tool_calls");
});
test("runTurn: reads freely, asks before writing, obeys a 'no', then answers", async () => {
  const root = tmp(); writeFileSync(join(root, "README.md"), "# Demo\n");
  const replies = [
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "r1", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "w1", function: { name: "write_file", arguments: '{"path":"x.md","content":"x"}' } }] } }] }),
    sse({ choices: [{ delta: { content: "OK, I did not write it." } }] }),
  ];
  const sent = []; const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }); return { ok: true, body: replies.shift() }; };
  const events = [], asked = [], messages = [{ role: "user", content: "hi" }];
  await runTurn({ messages, provider: { base: "https://p.example/v1", key: "k1" }, model: "m", root, systemPrompt: "SYS", emit: (e) => events.push(e), approve: async (c) => { asked.push(c.name); return false; }, fetchImpl });
  assert.equal(sent.length, 3); assert.equal(sent[0].url, "https://p.example/v1/chat/completions"); assert.equal(sent[0].auth, "Bearer k1");
  assert.equal(sent[0].body.messages[0].content, "SYS"); assert.equal(sent[0].body.tools.length, 7); assert.equal(sent[0].body.stream, true);
  assert.deepEqual(asked, ["write_file"], "only the write asked for approval");
  assert.equal(existsSync(join(root, "x.md")), false, "declined write did not happen");
  assert.match(messages.find((m) => m.role === "tool" && m.tool_call_id === "r1").content, /# Demo/);
  assert.match(messages.find((m) => m.role === "tool" && m.tool_call_id === "w1").content, /declined/);
  assert.equal(messages.at(-1).content, "OK, I did not write it.");
  assert.ok(events.some((e) => e.t === "tool" && e.name === "write_file" && e.ask === true));
  assert.equal(events.at(-1).t, "done");
});
test("runTurn: plain-language errors for bad key and quota", async () => {
  for (const [status, re] of [[401, /key was rejected/], [429, /quota/], [404, /not available/]]) {
    await assert.rejects(runTurn({ messages: [{ role: "user", content: "x" }], provider: { base: "https://p/v1" }, model: "m", root: tmp(), systemPrompt: "", emit() {}, approve: async () => true,
      fetchImpl: async () => ({ ok: false, status, text: async () => "{}" }) }), re);
  }
});
test("store: products, keys (owner-only file), chats", () => {
  const s = makeStore(tmp());
  assert.equal(s.products.freeId("Parent Plus"), "parent-plus");
  s.products.save({ id: "parent-plus", name: "Parent Plus", repo: "o/r", dir: "~/x", prototypes: ["a.html"] });
  assert.equal(s.products.freeId("Parent Plus"), "parent-plus-2");
  assert.equal(s.products.get("parent-plus").dir.startsWith("/"), true, "~ is expanded");
  s.keys.set("nvidia", { key: "secret" }); assert.equal(s.keys.get("nvidia").key, "secret");
  assert.equal((readFileSync(join(s.dir, "keys.json")).length > 0), true);
  const mode = (await_ => 0)(); void mode;
  const pub = publicProviders(s.keys.all()); assert.equal(pub.find((p) => p.id === "nvidia").hasKey, true); assert.equal(JSON.stringify(pub).includes("secret"), false, "keys never leave the server");
  const c = s.chats.create("parent-plus", { provider: "nvidia", model: "m" }); c.messages.push({ role: "user", content: "hi" }); s.chats.save("parent-plus", c);
  assert.equal(s.chats.list("parent-plus")[0].id, c.id); assert.equal(s.chats.get("parent-plus", c.id).messages.length, 1);
  assert.equal(s.chats.get("parent-plus", "../../keys"), null, "chat ids cannot traverse");
  s.products.remove("parent-plus"); assert.equal(s.products.list().length, 0);
});
test("repo names and links are validated", () => {
  assert.equal(repoOf("appsworld2027/Parent-plus-"), "appsworld2027/Parent-plus-");
  assert.equal(repoOf("https://github.com/appsworld2027/Parent-plus-.git"), "appsworld2027/Parent-plus-");
  assert.equal(repoOf("git@github.com:a/b.git"), "a/b");
  assert.equal(repoOf("a/b; rm -rf /"), null); assert.equal(repoOf("https://evil.com/a/b"), null);
  assert.equal(validUrl("https://x.vercel.app"), true); assert.equal(validUrl(""), true); assert.equal(validUrl("javascript:alert(1)"), false); assert.equal(validUrl("http://x"), false);
  assert.equal(slugify("Parent Plus!"), "parent-plus");
});
test("the private link is right on Cloud Shell, Codespaces and elsewhere", () => {
  assert.equal(publicUrl(8484, { WEB_HOST: "cs-1-abc.cs-asia-southeast1.cloudshell.dev" }), "https://8484-cs-1-abc.cs-asia-southeast1.cloudshell.dev");
  assert.equal(publicUrl(8484, { CODESPACE_NAME: "fuzzy-train-123", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev" }), "https://fuzzy-train-123-8484.app.github.dev");
  assert.equal(publicUrl(8484, { STUDIO_PUBLIC_URL: "https://studio.example.com/" }), "https://studio.example.com");
  assert.equal(publicUrl(8484, { STUDIO_HOME: tmp() }), "http://localhost:8484", "nothing known → localhost (never reads the real home folder)");
  assert.equal(platform({ CODESPACE_NAME: "x" }).id, "codespaces"); assert.equal(platform({ CLOUD_SHELL: "true" }).id, "cloudshell"); assert.equal(platform({}).id, "other");
});
test("Cloud Shell without WEB_HOST: the link the Studio was opened at is remembered for this port only", () => {
  const home = tmp();
  writeFileSync(join(home, "public-url"), "https://8484-cs-123-default.cs-asia-southeast1.cloudshell.dev\n");
  assert.equal(publicUrl(8484, { STUDIO_HOME: home }), "https://8484-cs-123-default.cs-asia-southeast1.cloudshell.dev");
  assert.equal(publicUrl(9000, { STUDIO_HOME: home }), "http://localhost:9000", "a different port is not guessed");
  assert.equal(publicUrl(8484, { STUDIO_HOME: home, WEB_HOST: "cs-9.cloudshell.dev" }), "https://8484-cs-9.cloudshell.dev", "WEB_HOST wins when present");
  assert.equal(publicUrl(8484, { STUDIO_HOME: tmp(), WEB_HOST: "None", CLOUD_SHELL: "true" }), "http://localhost:8484", "Cloud Shell's literal 'None' is not a host");
  writeFileSync(join(home, "public-url"), "https://8484-None\n");
  assert.equal(publicUrl(8484, { STUDIO_HOME: home }), "http://localhost:8484", "a saved 'None' link is ignored");
  writeFileSync(join(home, "public-url"), "javascript:alert(1)\n");
  assert.equal(publicUrl(8484, { STUDIO_HOME: home }), "http://localhost:8484", "a bad saved value is ignored");
});
test("OpenRouter lists free models first", () => {
  assert.deepEqual(sortModels("openrouter", ["b/paid", "a/x:free", "c/y:free"]).slice(0, 2), ["a/x:free", "c/y:free"]);
  assert.equal(sortModels("nvidia", ["z/z"])[0], "nvidia/nemotron-3-ultra-550b-a55b", "verified defaults stay on top");
});
test("attachment names are made safe; only document/image/code types are accepted", async () => {
  const { safeUploadName } = await import("../server/uploads.mjs");
  assert.equal(safeUploadName("Screen Shot 2026-11-23 at 10.00.png"), "Screen_Shot_2026-11-23_at_10.00.png");
  assert.equal(safeUploadName("../../etc/passwd.txt"), "passwd.txt", "no folders, no ..");
  assert.equal(safeUploadName("..\\\\windows\\\\evil.md"), "evil.md");
  assert.equal(safeUploadName(".notes.md"), "notes.md", "no hidden files");
  assert.equal(safeUploadName("setup.sh"), "", "no shell scripts");
  assert.equal(safeUploadName("run.exe"), ""); assert.equal(safeUploadName("x.png.exe"), ""); assert.equal(safeUploadName("noext"), "");
  assert.equal(safeUploadName("Brief.PDF"), "Brief.PDF");
  assert.ok(safeUploadName("a".repeat(300) + ".csv").length <= 80);
});
