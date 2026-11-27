// Founder policy: agent APIs are free-tier only. No environment override can enable paid APIs.
import { PROVIDERS } from "./providers.mjs";

export const paidAllowed = () => false;
export const GROQ_FREE_MODELS = new Set(["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]);
// Only real strings: an array such as ["openrouter"] would otherwise pass the lookup and skip the model rule.
export const validProvider = (id) => typeof id === "string" && Object.hasOwn(PROVIDERS, id);
export const validModel = (model) => typeof model === "string" && /^\S{1,200}$/.test(model);
export const isLocalModelBase = (base) => {
  try {
    const u = new URL(String(base || ""));
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "127.0.0.1" ||
      /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch { return false; }
};
export const providerAllowed = (id, env = process.env, base) => validProvider(id) &&
  (id === "custom" ? isLocalModelBase(base) : PROVIDERS[id].free === true);
// Free providers can expose paid models too. Keep Groq on an explicit free-tier model allowlist;
// OpenRouter requires its :free suffix. Custom OpenAI-compatible servers are allowed only on local/private hosts.
export const modelAllowed = (id, model, env = process.env, base) => providerAllowed(id, env, base) && validModel(model) &&
  (id === "openrouter" ? model.endsWith(":free") : id === "groq" ? GROQ_FREE_MODELS.has(model) : true);
export const BLOCKED = "Blocked: paid model APIs are disabled by founder policy. Choose an approved free-tier model.";

// Provider API keys are never inherited by spawned CLI processes; model providers are accessed through the dedicated key store.
export const PAID_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "AZURE_OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY"];
function testOnlyLocalAnthropic(env) {
  return env.STUDIO_TEST_MODE === "1" && isLocalModelBase(env.ANTHROPIC_BASE_URL);
}
function stripProviderCredentials(env) {
  const keepLocalTest = testOnlyLocalAnthropic(env);
  for (const k of PAID_ENV) {
    if (keepLocalTest && ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"].includes(k)) continue;
    delete env[k];
  }
}
export function planEnv(env = process.env) {
  const out = { ...env };
  stripProviderCredentials(out);
  return out;
}
// Called once when the server starts, so every program it launches inherits a clean environment.
// Only the isolated E2E harness may retain a fake Anthropic key pointed at a loopback test server.
export function scrubPaidEnv(env = process.env) {
  stripProviderCredentials(env);
}
