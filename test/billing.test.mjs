import test from "node:test";
import assert from "node:assert/strict";
import { providerAllowed, modelAllowed, planEnv, PAID_ENV } from "../server/billing.mjs";

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
test("only the exact owner opt-in lifts the block", () => {
  assert.equal(providerAllowed("openai", { STUDIO_ALLOW_PAID_APIS: "true" }), false);
  assert.equal(providerAllowed("openai", { STUDIO_ALLOW_PAID_APIS: "1" }), true);
  assert.equal(planEnv({ STUDIO_ALLOW_PAID_APIS: "1", OPENAI_API_KEY: "x" }).OPENAI_API_KEY, "x");
});
