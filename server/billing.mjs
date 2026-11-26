// Founder policy: agent APIs are free-tier only. No environment override can enable paid APIs.
import { PROVIDERS } from "./providers.mjs";

export const paidAllowed = () => false;
export const GROQ_FREE_MODELS = new Set(["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]);
// Only real strings: an array such as ["openrouter"] would otherwise pass the lookup and skip the model rule.
export const validProvider = (id) => typeof id === "string" && Object.hasOwn(PROVIDERS, id);
export const validModel = (model) => typeof model === "string" && /^\S{1,200}$/.test(model);
export const providerAllowed = (id) => validProvider(id) && PROVIDERS[id].free === true;
// Free providers can expose paid models too. Keep Groq on an explicit free-tier model allowlist;
// OpenRouter requires its :free suffix. Other free providers retain their provider-level free policy.
export const modelAllowed = (id, model) => providerAllowed(id) && validModel(model) &&
  (id === "openrouter" ? model.endsWith(":free") : id === "groq" ? GROQ_FREE_MODELS.has(model) : true);
export const BLOCKED = "Blocked: paid model APIs are disabled by founder policy. Choose an approved free-tier model.";

// Provider API keys are never inherited by spawned CLI processes; model providers are accessed through the dedicated key store.
export const PAID_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "AZURE_OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY"];
export function planEnv(env = process.env) {
  const out = { ...env };
  for (const k of PAID_ENV) delete out[k];
  return out;
}
// Called once when the server starts, so every program it launches inherits a clean environment.
export function scrubPaidEnv(env = process.env) {
  for (const k of PAID_ENV) delete env[k];
}
