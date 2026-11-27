import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../server/agent.mjs";
import {
  providerAllowed, modelAllowed, planEnv, PAID_ENV, paidAllowed,
  GROQ_FREE_MODELS, NVIDIA_FREE_MODELS, ZAI_FREE_MODELS, GEMINI_FREE_MODELS, isLocalModelBase
} from "../server/billing.mjs";
import { sortModels } from "../server/providers.mjs";

test("only explicitly supported free providers are allowed", () => {
  for (const id of ["nvidia", "openrouter", "groq", "zai", "gemini", "ollama"]) assert.equal(providerAllowed(id, {}), true, id);
  for (const id of ["openai", "anthropic", "custom", "unknown"]) assert.equal(providerAllowed(id, {}), false, id);
});

test("provider model catalogs expose only approved free IDs", () => {
  assert.deepEqual(sortModels("zai", ["glm-4.7", "glm-4.7-flash", "glm-5.3-flash"]), ["glm-4.7-flash"]);
  assert.deepEqual(sortModels("nvidia", ["nvidia/nemotron-3-ultra-550b-a55b", "mistralai/mistral-large-4-1t-a52b"]), ["nvidia/nemotron-3-ultra-550b-a55b"]);
  assert.deepEqual(sortModels("gemini", ["gemini-3.8-flash", "gemini-3-pro", "gemini-2.5-flash-lite"]), ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
  assert.deepEqual(sortModels("openrouter", ["vendor/paid", "vendor/free:free"]), ["vendor/free:free"]);
});

test("OpenRouter is limited to :free models and disallows paid fallback", () => {
  assert.equal(modelAllowed("openrouter", "vendor/model:free", {}), true);
  assert.equal(modelAllowed("openrouter", "vendor/model", {}), false);
  assert.equal(modelAllowed("openai", "any", {}), false);
});

test("NVIDIA, Z.AI and Gemini are restricted to exact zero-cost model allowlists", () => {
  assert.equal(modelAllowed("nvidia", "nvidia/nemotron-3-ultra-550b-a55b", {}), true);
  assert.equal(modelAllowed("nvidia", "mistralai/mistral-large-4-1t-a52b", {}), false);
  assert.equal(modelAllowed("zai", "glm-4.7-flash", {}), true);
  assert.equal(modelAllowed("zai", "glm-4.7", {}), false);
  assert.equal(modelAllowed("gemini", "gemini-3.8-flash", {}), true);
  assert.equal(modelAllowed("gemini", "gemini-3-pro", {}), false);
  assert.equal(NVIDIA_FREE_MODELS.size, 1);
  assert.equal(ZAI_FREE_MODELS.size, 1);
  assert.equal(GEMINI_FREE_MODELS.size, 3);
});

test("engines start without pay-per-use or subscription CLI credentials", () => {
  const env = {
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "paid-plan",
    CODEX_HOME: "/home/user/.codex",
    OPENCODE_API_KEY: "paid-console",
    ...Object.fromEntries(PAID_ENV.map((k) => [k, "x"]))
  };
  assert.deepEqual(planEnv(env), { PATH: "/bin" });
  assert.equal(env.OPENAI_API_KEY, "x", "the input is not changed");
});

test("paid API providers remain blocked even when a legacy opt-in is present", () => {
  assert.equal(paidAllowed({ STUDIO_ALLOW_PAID_APIS: "1" }), false);
  assert.equal(providerAllowed("openai", { STUDIO_ALLOW_PAID_APIS: "1" }), false);
  assert.equal(modelAllowed("anthropic", "claude-latest", { STUDIO_ALLOW_PAID_APIS: "1" }), false);
  assert.equal(planEnv({ STUDIO_ALLOW_PAID_APIS: "1", OPENAI_API_KEY: "x" }).OPENAI_API_KEY, undefined);
});

test("custom endpoints are blocked except for isolated loopback test fixtures", () => {
  const local = "http://127.0.0.1:11434/v1";
  assert.equal(isLocalModelBase(local), true);
  assert.equal(isLocalModelBase("http://192.168.1.8:1234/v1"), true);
  assert.equal(isLocalModelBase("https://api.example.com/v1"), false);
  assert.equal(providerAllowed("custom", {}, local), false);
  assert.equal(modelAllowed("custom", "local-model", {}, local), false);
  assert.equal(providerAllowed("custom", { STUDIO_TEST_MODE: "1" }, local), true);
  assert.equal(modelAllowed("custom", "local-model", { STUDIO_TEST_MODE: "1" }, local), true);
  assert.equal(providerAllowed("custom", { STUDIO_TEST_MODE: "1" }, "https://api.example.com/v1"), false);
});

test("E2E harness may use a fake Anthropic key only against a loopback test server", () => {
  const env = { STUDIO_TEST_MODE: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:1234", ANTHROPIC_API_KEY: "fake", OPENAI_API_KEY: "paid" };
  const clean = planEnv(env);
  assert.equal(clean.ANTHROPIC_API_KEY, "fake");
  assert.equal(clean.ANTHROPIC_BASE_URL, env.ANTHROPIC_BASE_URL);
  assert.equal(clean.OPENAI_API_KEY, undefined);
  assert.equal(planEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "real" }).ANTHROPIC_API_KEY, undefined);
});

test("Groq remains restricted to the explicit free-tier allowlist", () => {
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

test("commands run by the free-model chat do not receive provider credentials", async () => {
  const saved = { ...process.env };
  for (const k of PAID_ENV) delete process.env[k];
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.ZAI_API_KEY = "sk-zai-test";
  delete process.env.STUDIO_ALLOW_PAID_APIS;
  try {
    const out = await runTool(mkdtempSync(join(tmpdir(), "bill-")), "run_command", { command: "env" });
    assert.match(out, /exit 0/);
    assert.doesNotMatch(out, /ANTHROPIC_API_KEY|OPENAI_API_KEY|ZAI_API_KEY/);
  } finally {
    for (const k of PAID_ENV) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
