// Tests for agent→model matching, decision cards (ask_user) and thinking effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, needsFromText, parseAgent, ENGINE_MODELS } from "../server/team.mjs";
import { normalizeQuestion, effortFields, runTurn, toolSchemas } from "../server/agent.mjs";

const A = (slug, name, role = "", description = "") => ({ slug, name, role, description });
const TEAM = [A("maya-ai-pm", "Maya", "AI Product Manager"), A("dev-coder", "Dev", "Coding Specialist"), A("quinn-qa", "Quinn", "QA Specialist"), A("rex-reviewer", "Rex", "Reviewer"), A("kiran-pjm-a", "Kiran", "Project Manager")];
const all = (ids) => Object.fromEntries(ids.map((i) => [i, true]));
const pick = (rows, slug) => rows.find((r) => r.slug === slug).pick?.id;

const BUILDER = "free:gpt-oss-120b";
const REVIEWER = "free:qwen-3.8-27b";
const ALL_FREE = ENGINE_MODELS.map((m) => m.id);

test("agent model pool is strictly Groq free-tier; builders and reviewers differ", () => {
  assert.ok(ENGINE_MODELS.length >= 2);
  assert.ok(ENGINE_MODELS.every((m) => m.engine === "free" && m.cost === 0));
  assert.ok(ENGINE_MODELS.every((m) => m.id.startsWith("free:") && m.model));
  assert.doesNotMatch(ENGINE_MODELS.map((m) => m.name + " " + m.id).join(" "), /Claude|Codex|NVIDIA|Anthropic|OpenAI API/i);
  const rows = plan({ agents: TEAM, available: all(ALL_FREE) });
  assert.equal(pick(rows, "dev-coder"), BUILDER);
  assert.equal(pick(rows, "quinn-qa"), REVIEWER);
  assert.equal(pick(rows, "rex-reviewer"), REVIEWER);
  assert.match(rows.find((r) => r.slug === "rex-reviewer").why, /different model from the builder/);
});

test("no plan or paid engine can enter the agent assignment pool", () => {
  const rows = plan({ agents: TEAM, available: all([...ALL_FREE, "claude:opus", "codex:default", "openai:api"]) });
  assert.ok(rows.every((r) => !r.pick || ENGINE_MODELS.some((m) => m.id === r.pick.id && m.engine === "free" && m.cost === 0)));
});

test("a backup is offered only when it is permitted for the seat", () => {
  const rows = plan({ agents: TEAM, available: all(ALL_FREE) });
  for (const r of rows) {
    if (["dev-coder", "quinn-qa", "rex-reviewer"].includes(r.slug)) {
      assert.equal(r.fallback, null, `${r.slug} has no other approved seat model`);
    } else {
      assert.ok(r.fallback && r.fallback.id !== r.pick.id, `${r.slug} has a different backup`);
    }
  }
});

test("only one builder model available: independent QA and review pause", () => {
  const rows = plan({ agents: TEAM, available: all([BUILDER]) });
  assert.equal(pick(rows, "dev-coder"), BUILDER);
  for (const slug of ["quinn-qa", "rex-reviewer"]) {
    assert.equal(pick(rows, slug), undefined);
    assert.match(rows.find((r) => r.slug === slug).why, /independent reviewer/i);
  }
});
test("nothing available: no crash, plain message", () => {
  const rows = plan({ agents: TEAM, available: {} });
  assert.equal(rows[0].pick, null); assert.match(rows[0].why, /No AI connected/);
});
test("overrides cannot weaken independence even if the requested model is available", () => {
  const avail = all(ALL_FREE);
  const base = plan({ agents: TEAM, available: avail });
  const dev = pick(base, "dev-coder");
  const rows = plan({ agents: TEAM, available: avail, overrides: { "rex-reviewer": dev, "maya-ai-pm": "claude:opus" } });
  assert.equal(pick(rows, "rex-reviewer"), REVIEWER);
  assert.match(rows.find((r) => r.slug === "rex-reviewer").why, /override rejected/i);
  assert.equal(rows.find((r) => r.slug === "rex-reviewer").overridden, false);
  assert.notEqual(pick(rows, "maya-ai-pm"), "claude:opus", "an override for an AI you do not have is ignored");
});
test("custom agents of any product are matched from their job description", () => {
  assert.ok(needsFromText("Writes database migrations and APIs").coding === 3);
  assert.ok(needsFromText("Reviews pull requests for security").review === 3);
  const rows = plan({ agents: [A("sec-bot", "Sentinel", "Security Auditor", "Audits code for security issues")], available: all(ALL_FREE) });
  assert.equal(pick(rows, "sec-bot"), REVIEWER, "the stronger reviewer of the two free models");
});
test("parseAgent reads AI Org role files", () => {
  const a = parseAgent("---\nslug: dev-coder\nname: Dev\nrole: Coding Specialist\ndescription: Implements one issue.\nmodel: default\n---\n\n# Dev");
  assert.deepEqual(a, { slug: "dev-coder", name: "Dev", role: "Coding Specialist", description: "Implements one issue." });
});

test("ask_user: questions are cleaned up; bad ones are rejected", () => {
  assert.equal(toolSchemas().some((t) => t.function.name === "ask_user"), true);
  assert.deepEqual(normalizeQuestion({ question: "Which?", options: ["A", { label: "B", detail: "slower" }], recommended: 1 }),
    { question: "Which?", options: [{ label: "A", detail: "" }, { label: "B", detail: "slower" }], recommended: 1 });
  assert.equal(normalizeQuestion({ question: "Which?", options: ["only one"] }), null);
  assert.equal(normalizeQuestion({ question: "Q", options: ["a", "b", "c", "d", "e"], recommended: 9 }).options.length, 4);
  assert.equal(normalizeQuestion({ question: "Q", options: ["a", "b"], recommended: 9 }).recommended, 0);
});
const sse = (...events) => { const s = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"; return (async function* () { yield new TextEncoder().encode(s); })(); };
test("runTurn: ask_user waits for the owner's click and passes the answer back to the model", async () => {
  const replies = [
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "q1", function: { name: "ask_user", arguments: JSON.stringify({ question: "Where should Overdue go?", options: [{ label: "Top of Fees" }, { label: "Own tab" }], recommended: 0 }) } }] } }] }),
    sse({ choices: [{ delta: { content: "Great, top of Fees it is." } }] }),
  ];
  const bodies = []; const events = []; const messages = [{ role: "user", content: "add overdue list" }];
  await runTurn({ messages, provider: { id: "nvidia", base: "https://p/v1" }, model: "m", effort: "high", root: mkdtempSync(join(tmpdir(), "t-")), systemPrompt: "S", emit: (e) => events.push(e),
    approve: async () => { throw new Error("must not ask approval for a question"); }, askUser: async (q) => { assert.equal(q.options[q.recommended].label, "Top of Fees"); return "Top of Fees (the recommended option)"; },
    fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return { ok: true, body: replies.shift() }; } });
  assert.ok(events.some((e) => e.t === "ask" && e.question === "Where should Overdue go?"));
  assert.match(messages.find((m) => m.role === "tool").content, /chose: Top of Fees/);
  assert.equal(bodies[0].reasoning_effort, "high", "thinking level sent the standard way");
  assert.equal(messages.at(-1).content, "Great, top of Fees it is.");
});
test("thinking effort: each provider gets its own field; a model that refuses it is retried without", async () => {
  assert.deepEqual(effortFields("openrouter", "low"), { reasoning: { effort: "low" } });
  assert.deepEqual(effortFields("groq", "medium"), { reasoning_effort: "medium" });
  assert.deepEqual(effortFields("anthropic", "high"), {});
  assert.deepEqual(effortFields("nvidia", "default"), {});
  const bodies = [], events = [];
  let n = 0;
  await runTurn({ messages: [{ role: "user", content: "x" }], provider: { id: "groq", base: "https://p/v1" }, model: "m", effort: "high", root: mkdtempSync(join(tmpdir(), "t-")), systemPrompt: "", emit: (e) => events.push(e), approve: async () => true,
    fetchImpl: async (u, o) => { bodies.push(JSON.parse(o.body)); return n++ === 0 ? { ok: false, status: 400, text: async () => '{"error":"reasoning_effort is not supported by this model"}' } : { ok: true, body: sse({ choices: [{ delta: { content: "ok" } }] }) }; } });
  assert.equal(bodies.length, 2); assert.equal(bodies[0].reasoning_effort, "high"); assert.equal(bodies[1].reasoning_effort, undefined);
  assert.ok(events.some((e) => e.t === "note" && /does not take a thinking level/.test(e.message)));
});

test("builders cannot select the reserved independent reviewer model", () => {
  const agents = [...TEAM, A("tara-database", "Tara"), A("ravi-integration", "Ravi")];
  const overrides = Object.fromEntries(["dev-coder", "tara-database", "ravi-integration"].map(slug => [slug, REVIEWER]));
  const rows = plan({ agents, available: all(ALL_FREE), overrides });
  for (const slug of Object.keys(overrides)) {
    assert.equal(pick(rows, slug), BUILDER);
    assert.match(rows.find(r => r.slug === slug).why, /override rejected/i);
  }
  assert.equal(pick(rows, "rex-reviewer"), REVIEWER);
});
test("reviewer-only connection cannot substitute for an unavailable builder", () => {
  const rows = plan({ agents: TEAM, available: all([REVIEWER]) });
  assert.equal(pick(rows, "dev-coder"), undefined);
  assert.match(rows.find(r => r.slug === "dev-coder").why, /approved builder/i);
  assert.equal(pick(rows, "rex-reviewer"), REVIEWER);
});
