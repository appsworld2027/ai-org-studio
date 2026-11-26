// Subscription-only by default: the Studio does not spend per-use API money.
// Only the person who starts the server can opt out (STUDIO_ALLOW_PAID_APIS=1); that is the owner's spend approval.
import { PROVIDERS } from "./providers.mjs";

export const paidAllowed = (env = process.env) => env.STUDIO_ALLOW_PAID_APIS === "1";
// Only real strings: an array such as ["openrouter"] would otherwise pass the lookup and skip the model rule.
export const validProvider = (id) => typeof id === "string" && Object.hasOwn(PROVIDERS, id);
export const validModel = (model) => typeof model === "string" && /^\S{1,200}$/.test(model);
export const providerAllowed = (id, env = process.env) => validProvider(id) && (paidAllowed(env) || PROVIDERS[id].free === true);
// OpenRouter has free and paid models under one key; only ids ending in ":free" cost nothing.
export const modelAllowed = (id, model, env = process.env) => providerAllowed(id, env) && validModel(model) && (paidAllowed(env) || id !== "openrouter" || model.endsWith(":free"));
export const BLOCKED = "Blocked: this could be billed per use. AI Org Studio runs on your Claude and ChatGPT plans and free models only.";

// Variables that switch Claude Code or Codex from your plan to a separately billed API.
export const PAID_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "AZURE_OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY"];
export function planEnv(env = process.env) {
  const out = { ...env };
  if (!paidAllowed(env)) for (const k of PAID_ENV) delete out[k];
  return out;
}
// Called once when the server starts, so every program it launches inherits a clean environment.
export function scrubPaidEnv(env = process.env) {
  if (!paidAllowed(env)) for (const k of PAID_ENV) delete env[k];
}
