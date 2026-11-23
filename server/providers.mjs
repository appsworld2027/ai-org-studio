// AI providers for the Studio-drawn chat ("Other models"). All speak the OpenAI-compatible Chat Completions API.
// Claude Code and Codex are NOT here: they run as their own official programs with the user's own login.
// Model lists are fetched live from each provider (GET /models) after the key is saved; the defaults below are only
// models we have verified with tool use.
export const PROVIDERS = {
  nvidia: {
    name: "NVIDIA (free)", base: "https://integrate.api.nvidia.com/v1", needsKey: true, free: true,
    keyHelp: "Free key: build.nvidia.com → sign in → API keys.",
    models: ["nvidia/nemotron-3-ultra-550b-a55b", "mistralai/mistral-large-4-1t-a52b"],
  },
  openrouter: {
    name: "OpenRouter (free models)", base: "https://openrouter.ai/api/v1", needsKey: true, free: true,
    keyHelp: "Free key: openrouter.ai → Keys. Models ending in :free cost nothing.",
    models: [], preferFree: true,
  },
  groq: {
    name: "Groq (free tier)", base: "https://api.groq.com/openai/v1", needsKey: true, free: true,
    keyHelp: "Free key: console.groq.com → API Keys.", models: [],
  },
  gemini: {
    name: "Google Gemini (free tier)", base: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, free: true,
    keyHelp: "Free key: aistudio.google.com → Get API key.", models: [],
  },
  ollama: {
    name: "Ollama (on this machine)", base: "http://127.0.0.1:11434/v1", needsKey: false, free: true,
    keyHelp: "No key. Install Ollama in this machine and pull a model first.", models: [],
  },
  openai: {
    name: "OpenAI API (pay per use)", base: "https://api.openai.com/v1", needsKey: true, free: false,
    keyHelp: "API key from platform.openai.com. This is billed per use, separate from a ChatGPT plan.", models: [],
  },
  anthropic: {
    name: "Anthropic API (pay per use)", base: "https://api.anthropic.com/v1", needsKey: true, free: false,
    keyHelp: "API key from platform.claude.com. Billed per use. To use your Claude plan instead, pick the Claude Code tab.", models: [],
  },
  custom: {
    name: "Other (OpenAI-compatible)", base: "", needsKey: false, free: false,
    keyHelp: "Any server that speaks the OpenAI Chat Completions API.", models: [], custom: true,
  },
};

// Sort a fetched model list: free models first for OpenRouter, then alphabetical; cap the list.
export function sortModels(provider, ids = []) {
  const p = PROVIDERS[provider] || {};
  const uniq = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  uniq.sort((a, b) => (p.preferFree ? Number(!a.endsWith(":free")) - Number(!b.endsWith(":free")) : 0) || a.localeCompare(b));
  return [...new Set([...(p.models || []), ...uniq])].slice(0, 300);
}

export function publicProviders(secrets = {}) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name, free: p.free, needsKey: p.needsKey, keyHelp: p.keyHelp, custom: !!p.custom,
    hasKey: !!secrets[id]?.key, base: p.custom ? secrets[id]?.base || "" : p.base, models: p.models,
  }));
}
