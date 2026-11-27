// Free model providers for Studio's OpenAI-compatible tool-calling agent.
// Paid API providers remain visible only as blocked choices; they cannot be used by agent turns.
export const PROVIDERS = {
  nvidia: {
    name: "NVIDIA NIM (free endpoint)",
    base: "https://integrate.api.nvidia.com/v1",
    needsKey: true,
    free: true,
    keyHelp: "Free endpoint key: build.nvidia.com → sign in → API keys. Only the explicitly allowlisted model is enabled.",
    models: ["nvidia/nemotron-3-ultra-550b-a55b"],
  },
  openrouter: {
    name: "OpenRouter (free models only)",
    base: "https://openrouter.ai/api/v1",
    needsKey: true,
    free: true,
    keyHelp: "Free key: openrouter.ai → Keys. Only model IDs ending in :free are accepted; paid fallback is disabled.",
    models: [],
    preferFree: true,
  },
  groq: {
    name: "Groq (free tier)",
    base: "https://api.groq.com/openai/v1",
    needsKey: true,
    free: true,
    keyHelp: "Free key: console.groq.com → API Keys. Only verified free-tier models are enabled.",
    models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
  },
  zai: {
    name: "Z.AI GLM (free Flash models)",
    base: "https://api.z.ai/api/paas/v4",
    needsKey: true,
    free: true,
    keyHelp: "Free GLM Flash API: docs.z.ai. Only explicitly listed zero-price Flash models are accepted.",
    models: ["glm-4.7-flash"],
  },
  gemini: {
    name: "Google Gemini (free tier)",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    free: true,
    keyHelp: "Free tier models only. Google states free-tier content may be used to improve its products; send public code and synthetic data only.",
    models: ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  ollama: {
    name: "Ollama (local inference)",
    base: "http://127.0.0.1:11434/v1",
    needsKey: false,
    free: true,
    keyHelp: "No API key or provider bill. Requires Ollama and a model installed on this machine.",
    models: [],
  },
  openai: {
    name: "OpenAI API (blocked — paid)",
    base: "https://api.openai.com/v1",
    needsKey: true,
    free: false,
    keyHelp: "Blocked by the founder's free-only policy.",
    models: [],
  },
  anthropic: {
    name: "Anthropic API (blocked — paid)",
    base: "https://api.anthropic.com/v1",
    needsKey: true,
    free: false,
    keyHelp: "Blocked by the founder's free-only policy.",
    models: [],
  },
  custom: {
    name: "Custom provider (blocked)",
    base: "",
    needsKey: false,
    free: false,
    keyHelp: "Custom endpoints are disabled for agent execution so they cannot proxy to an unverified paid provider.",
    models: [],
    custom: true,
  },
};

// Restrict live model catalogs to exact, reviewed free IDs. OpenRouter is free only with :free suffix;
// Ollama is local and has no per-token API billing.
export function sortModels(provider, ids = [], { allowLocalFixture = false } = {}) {
  const p = PROVIDERS[provider] || {};
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  if (provider === "openrouter") {
    const free = [...new Set([...(p.models || []), ...uniq])].filter((x) => x.endsWith(":free"));
    return free.sort((a, b) => a.localeCompare(b)).slice(0, 300);
  }
  // Custom catalogs are enabled only by the caller after the loopback test policy passes.
  if (provider === "custom") return allowLocalFixture ? uniq.slice(0, 300) : [];
  if (provider === "ollama") {
    return [...new Set([...(p.models || []), ...uniq])].slice(0, 300);
  }
  const allow = new Set(p.models || []);
  return [...new Set([...(p.models || []), ...uniq])].filter((x) => allow.has(x)).slice(0, 300);
}

export function publicProviders(secrets = {}) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name, free: p.free, needsKey: p.needsKey, keyHelp: p.keyHelp, custom: !!p.custom,
    hasKey: !!secrets[id]?.key, base: p.custom ? secrets[id]?.base || "" : p.base, models: p.models,
  }));
}
