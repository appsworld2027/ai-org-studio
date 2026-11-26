import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../server/agent.mjs";
import { providerAllowed, modelAllowed, planEnv, PAID_ENV, paidAllowed, GROQ_FREE_MODELS } from "../server/billing.mjs";

test("by default only free providers are allowed", () => {
  for (const id of ["nvidia", "openrouter", "groq", "gemini", "ollama"]) assert.equal(providerAllowed(id, {}), true, id);
  for (const id of ["openai", "anthropic", "custom", "unknown"]) assert.equal(providerAllowed(id, {}), false, id);
});
test("OpenRouter is limited to :free models", () => {
  assert.equal(modelAllowed("openrouter", "vendor/model:free", {}), true);
  assert.equal(modelAllowed("openrouter", "vendor/model", {}), false);
  assert.equal(modelAllowed("openai", "any", {}), false);
});
test("engines start without pay-per-use credentials, keeping the plan sign-in", () => {
  const env = { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "plan", ...Object.fromEntries(PAID_ENV.map((k) => [k, "x"])) };
  assert.deepEqual(planEnv(env), { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "plan" });
  assert.equal(env.OPENAI_API_KEY, "x", "the input is not changed");
});
test("paid API providers remain blocked even when the legacy opt-in is present", () => {
  assert.equal(paidAllowed({ STUDIO_ALLOW_PAID_APIS: "1" }), false);
  assert.equal(providerAllowed("openai", { STUDIO_ALLOW_PAID_APIS: "1" }), false);
  assert.equal(modelAllowed("anthropic", "claude-latest", { STUDIO_ALLOW_PAID_APIS: "1" }), false);
  assert.equal(planEnv({ STUDIO_ALLOW_PAID_APIS: "1", OPENAI_API_KEY: "x" }).OPENAI_API_KEY, undefined);
});
test("Groq is restricted to the explicit free-tier allowlist", () => {
  assert.equal(modelAllowed("groq", "openai/gpt-oss-120b", {}), true);
  assert.equal(modelAllowed("groq", "qwen/qwen3.8-27b", {}), true);
  assert.equal(modelAllowed("groq", "openai/gpt-oss-20b", {}), true);
  assert.equal(modelAllowed("groq", "minimaxai/minimax-m2.7", {}), false);
  assert.equal(GROQ_FREE_MODELS.size, 3);
});

test("a provider or model that is not a plain string is rejected", () => {
  assert.equal(modelAllowed(["openrouter"], "vendor/paid", {}), false);
  assert.equal(providerAllowed(["nvidia"], {}), false);
  assert.equal(providerAllowed("__proto__", { STUDIO_ALLOW_PAID_APIS: "1" }), false);
  assert.equal(modelAllowed("openrouter", ["x:free"], {}), false);
  assert.equal(modelAllowed("openrouter", "vendor/paid" + " ".repeat(200) + ":free", {}), false);
  assert.equal(modelAllowed("openrouter", "v/".padEnd(201, "a") + ":free", {}), false);
});
test("commands run by the free-model chat do not receive pay-per-use credentials", async () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test"; process.env.OPENAI_API_KEY = "sk-test"; delete process.env.STUDIO_ALLOW_PAID_APIS;
  try {
    const out = await runTool(mkdtempSync(join(tmpdir(), "bill-")), "run_command", { command: "env" });
    assert.match(out, /exit 0/); assert.doesNotMatch(out, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  } finally { for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete process.env[k]; Object.assign(process.env, saved); }
});
