// Founder policy: agent APIs are free-tier only. No environment override can enable paid APIs.
import { PROVIDERS } from "./providers.mjs";

export const paidAllowed = () => false;
export const GROQ_FREE_MODELS = new Set(["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"]);
export const NVIDIA_FREE_MODELS = new Set(["nvidia/nemotron-3-ultra-550b-a55b"]);
export const ZAI_FREE_MODELS = new Set(["glm-4.7-flash"]);
export const GEMINI_FREE_MODELS = new Set(["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"]);
// Only real strings: arrays and objects must never pass provider/model validation.
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
  (id === "custom" ? env.STUDIO_TEST_MODE === "1" && isLocalModelBase(base) : PROVIDERS[id].free === true);

// A provider's free tier does not make every model free. Enforce exact model allowlists.
export const modelAllowed = (id, model, env = process.env, base) => {
  if (!providerAllowed(id, env, base) || !validModel(model)) return false;
  if (id === "openrouter") return model.endsWith(":free");
  if (id === "ollama") return true;
  if (id === "custom") return env.STUDIO_TEST_MODE === "1" && isLocalModelBase(base);
  if (id === "groq") return GROQ_FREE_MODELS.has(model);
  if (id === "nvidia") return NVIDIA_FREE_MODELS.has(model);
  if (id === "zai") return ZAI_FREE_MODELS.has(model);
  if (id === "gemini") return GEMINI_FREE_MODELS.has(model);
  return false;
};
export const BLOCKED = "Blocked: paid model APIs are disabled by founder policy. Choose an approved free-tier model.";

// Provider credentials never enter spawned shells. The model server uses the dedicated key store.
export const PAID_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME",
  "OPENCODE_API_KEY", "OPENCODE_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK", "AZURE_OPENAI_API_KEY",
  "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY",
  "NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY", "ZAI_API_KEY"
];
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
