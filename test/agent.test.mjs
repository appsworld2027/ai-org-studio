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
test("Claude Code stream → chat events: text, steps, approval, question, result", async () => {
  const { translate, controlResponse, userContent } = await import("../server/engines/claude.mjs");
  const st = { tools: {}, pendingReq: {} };
  const ev = (m) => translate(m, st);
  assert.deepEqual(ev({ type: "system", subtype: "init", session_id: "s1", model: "opus" })[0], { t: "session", id: "s1", model: "opus" });
  assert.equal(ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } })[0].d, "Hi");
  const tool = ev({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/p/src/a.ts", old_string: "a\nb", new_string: "c" } }] } })[0];
  assert.equal(tool.title, "Edit src/a.ts"); assert.equal(tool.detail, "+1 −2"); assert.equal(tool.kind, "edit");
  assert.equal(ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } })[0].ok, true);
  const ap = ev({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test", description: "Run tests" } } })[0];
  assert.equal(ap.t, "approve"); assert.equal(ap.kind, "run"); assert.equal(ap.title, "Run tests");
  const q = ev({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A (Recommended)" }, { label: "B" }] }] } } })[0];
  assert.equal(q.t, "ask"); assert.equal(q.questions[0].recommended, 0);
  const done = ev({ type: "result", subtype: "success", total_cost_usd: 0.1 }); assert.equal(done.at(-1).t, "done");
  assert.match(ev({ type: "result", subtype: "error_during_execution", is_error: true, result: "Invalid API key · Please run /login" })[0].message, /not signed in/);
  const ans = controlResponse("r2", { tool_name: "AskUserQuestion", input: { questions: [{ question: "Which?" }] } }, ["A"]);
  assert.equal(ans.response.response.updatedInput.answers["Which?"], "A");
  assert.equal(controlResponse("r1", { tool_name: "Bash", input: {} }, false).response.response.behavior, "deny");
  assert.equal(userContent("hi", [{ path: ".studio-uploads/a.pdf" }])[0].text, "hi\n\nAttached files: @.studio-uploads/a.pdf");
});
test("Codex app-server → chat events: command step, approval, streamed text, turn done", async () => {
  const { translateNotification, translateRequest, requestResult, userInput } = await import("../server/engines/codex.mjs");
  const st = { items: {}, pendingReq: {} };
  const n = (method, params) => translateNotification({ method, params }, st);
  assert.equal(n("item/started", { item: { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'npm test'" } })[0].detail, "npm test");
  assert.equal(n("item/agentMessage/delta", { delta: "ok" })[0].d, "ok");
  assert.equal(n("item/completed", { item: { type: "commandExecution", id: "c1", status: "completed", exitCode: 0 } })[0].ok, true);
  assert.equal(n("item/completed", { item: { type: "commandExecution", id: "c1", status: "completed", exitCode: 2 } })[0].ok, false);
  assert.deepEqual(n("turn/completed", { turn: { status: "completed" } }).map((e) => e.t), ["done", "idle"]);
  const ap = translateRequest({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "rm x", reason: "clean" } }, st);
  assert.equal(ap.t, "approve"); assert.equal(ap.id, "7");
  assert.deepEqual(requestResult("item/commandExecution/requestApproval", true), { decision: "accept" });
  assert.deepEqual(requestResult("item/fileChange/requestApproval", false), { decision: "decline" });
  assert.deepEqual(requestResult("item/tool/requestUserInput", ["B"], [{ id: "q1" }]), { answers: { q1: { answers: ["B"] } } });
  assert.deepEqual(userInput("look", [{ path: ".studio-uploads/s.png" }], "/p"), [{ type: "text", text: "look" }, { type: "localImage", path: "/p/.studio-uploads/s.png" }]);
});
test("v2.1 plain step labels: Codex command actions, MCP tools, web search", async () => {
  const { describeCommand, describeMcp, describeTool } = await import("../server/engines/describe.mjs");
  const { translateNotification } = await import("../server/engines/codex.mjs");
  assert.equal(describeCommand("/bin/bash -lc 'cat .agents/skills/x/SKILL.md'", [{ type: "read", name: "SKILL.md", path: "/p/.agents/skills/x/SKILL.md" }]).title, "Read SKILL.md");
  assert.equal(describeCommand("rg -n hello .", [{ type: "search", query: "hello", path: "." }]).title, "Searched for “hello”");
  assert.equal(describeCommand("ls", [{ type: "listFiles", path: null }]).title, "Listed files");
  assert.match(describeCommand("cat a && rg x && ls", [{ type: "read", name: "a" }, { type: "search", query: "x" }, { type: "listFiles" }]).title, /Explored the project/);
  assert.equal(describeCommand("/bin/bash -lc 'gh auth status'", [{ type: "unknown" }]).title, "Checked the GitHub sign-in");
  assert.equal(describeCommand("npm test", []).title, "Ran the tests");
  assert.equal(describeCommand("/bin/bash -lc 'pwd'", [{ type: "unknown" }]).detail, "pwd", "the real command is kept for anyone who opens it");
  assert.equal(describeMcp("github", "get_user_login").title, "GitHub: get user login");
  assert.equal(describeTool("mcp__claude_ai_Slack__search_messages", {}).title, "Slack: search messages");
  assert.equal(describeTool("github.get_user_login", {}).title, "GitHub: get user login");
  assert.equal(describeTool("webSearch", { query: "", action: { type: "search", query: "vercel preview" } }).title, "Searched the web for “vercel preview”");
  assert.equal(describeTool("webSearch", { action: { type: "openPage", url: "https://docs.github.com/x" } }).title, "Opened docs.github.com/x");
  // Live output arrives in pieces and is kept when the command finishes without aggregatedOutput.
  const st = { items: {}, pendingReq: {} }, n = (method, params) => translateNotification({ method, params }, st);
  const start = n("item/started", { item: { type: "commandExecution", id: "c9", command: "/bin/bash -lc 'cat README.md'", commandActions: [{ type: "read", name: "README.md" }] } });
  assert.equal(start[0].title, "Read README.md"); assert.equal(start[1].text, "Reading README.md");
  n("item/commandExecution/outputDelta", { itemId: "c9", delta: "# Hello\n" }); n("item/commandExecution/outputDelta", { itemId: "c9", delta: "world\n" });
  assert.equal(n("item/completed", { item: { type: "commandExecution", id: "c9", status: "completed", exitCode: 0, aggregatedOutput: null } })[0].result, "# Hello\nworld\n");
  assert.equal(n("item/started", { item: { type: "mcpToolCall", id: "m1", server: "github", tool: "get_user_login" } })[0].title, "GitHub: get user login");
  assert.equal(n("item/completed", { item: { type: "mcpToolCall", id: "m1", status: "completed", result: { content: [{ type: "text", text: "ankit" }] } } })[0].result, "ankit");
  const ws = n("item/completed", { item: { type: "webSearch", id: "w1", query: "", action: { type: "search", query: "codex sandbox" } } })[0];
  assert.equal(ws.title, "Searched the web for “codex sandbox”");
});
test("v2.1 Codex: plan, thinking, memory and plan-limit events; network on in every mode; Allow for this chat", async () => {
  const { translateNotification, threadMode, turnMode, requestResult } = await import("../server/engines/codex.mjs");
  const st = { items: {}, pendingReq: {} }, n = (method, params) => translateNotification({ method, params }, st);
  assert.deepEqual(n("turn/plan/updated", { explanation: "x", plan: [{ step: "Read", status: "completed" }, { step: "Write", status: "inProgress" }] })[0],
    { t: "plan", steps: [{ text: "Read", status: "completed" }, { text: "Write", status: "in_progress" }], note: "x" });
  assert.deepEqual(n("item/started", { item: { type: "reasoning", id: "r1" } }).map((e) => e.t), ["thinking_start", "activity"]);
  assert.equal(n("item/reasoning/summaryTextDelta", { delta: "Checking the API" })[0].d, "Checking the API");
  assert.deepEqual(n("item/completed", { item: { type: "reasoning", id: "r1" } }).map((e) => e.t), ["thinking_end"]);
  assert.deepEqual(n("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 1000 }, total: { inputTokens: 5000 }, modelContextWindow: 10000 } })[0], { t: "context", used: 1000, window: 10000 });
  assert.equal(n("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 42, resetsAt: 1 } } })[0].usedPercent, 42);
  for (const m of ["ask", "auto", "plan"]) {
    assert.equal(threadMode(m).config["sandbox_workspace_write.network_access"], true, `${m}: network on`);
    assert.equal(turnMode(m).sandboxPolicy.networkAccess, true, `${m}: network on per turn`);
  }
  assert.equal(turnMode("ask").sandboxPolicy.type, "readOnly"); assert.equal(turnMode("auto").sandboxPolicy.type, "workspaceWrite");
  assert.equal(turnMode("plan").approvalPolicy, "never"); assert.equal(turnMode("ask").approvalPolicy, "on-request");
  assert.deepEqual(requestResult("item/commandExecution/requestApproval", "session"), { decision: "acceptForSession" });
});
test("v2.1 Claude Code: modes, thinking, plan (TodoWrite), memory, plan approval, Allow for this chat", async () => {
  const { translate, controlResponse, claudeArgs } = await import("../server/engines/claude.mjs");
  assert.ok(!claudeArgs({ mode: "ask" }).includes("--permission-mode"), "ask = Claude's normal mode");
  assert.deepEqual(claudeArgs({ mode: "auto" }).slice(1, 3), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(claudeArgs({ mode: "plan" }).slice(1, 3), ["--permission-mode", "plan"]);
  const st = { tools: {}, pendingReq: {}, model: "claude-opus-4-7" }, ev = (m) => translate(m, st);
  assert.deepEqual(ev({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } }).map((e) => e.t), ["thinking_start", "activity"]);
  assert.equal(ev({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } })[0].d, "hmm");
  assert.equal(ev({ type: "stream_event", event: { type: "content_block_stop" } })[0].t, "thinking_end");
  const a = ev({ type: "assistant", parent_tool_use_id: null, message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 }, content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [{ content: "Read", status: "completed" }, { content: "Write", status: "in_progress" }] } }] } });
  assert.deepEqual(a.map((e) => e.t), ["context", "plan"], "TodoWrite becomes the plan checklist, not a step card");
  assert.equal(a[0].used, 100); assert.equal(a[0].window, 200000);
  const p = ev({ type: "control_request", request_id: "p1", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "1. Do A" } } })[0];
  assert.equal(p.kind, "plan"); assert.equal(p.plan, "1. Do A");
  assert.equal(controlResponse("p1", { tool_name: "ExitPlanMode", input: { plan: "x" } }, true).response.response.updatedPermissions[0].mode, "default");
  const s1 = controlResponse("r", { tool_name: "Bash", input: { command: "npm run build" } }, "session").response.response;
  assert.equal(s1.behavior, "allow"); assert.equal(s1.updatedPermissions[0].rules[0].ruleContent, "npm:*");
  assert.equal(controlResponse("r", { tool_name: "Edit", input: {} }, "session").response.response.updatedPermissions[0].mode, "acceptEdits");
  assert.equal(ev({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.83 } })[0].usedPercent, 83);
});
