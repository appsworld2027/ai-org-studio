// Agent → model matching. Each agent's job description says what it needs most; each model has strengths;
// the best available model wins. One hard rule: a reviewer never uses the same model as the builder it checks.
// Pure logic (unit-tested). The same table can drive the AI Org router later.

// What each AI Org role needs most (weights 0-3). Unknown roles are read from their job description text.
export const ROLE_NEEDS = {
  "maya-ai-pm": { reasoning: 3, writing: 3, product: 3 },
  "arjun-cpto": { reasoning: 3, coding: 2, review: 2 },
  "dev-coder": { coding: 3, toolUse: 3, speed: 1 },
  "tara-database": { coding: 3, reasoning: 2, toolUse: 2 },
  "ravi-integration": { coding: 3, toolUse: 2 },
  "quinn-qa": { review: 3, coding: 2, toolUse: 2 },
  "rex-reviewer": { review: 3, reasoning: 2 },
  "iris-design": { writing: 2, product: 2, coding: 1 },
  "kiran-pjm-a": { speed: 3, writing: 1 },
  "leela-pjm-b": { speed: 3, writing: 1 },
  "sam-release": { speed: 2, toolUse: 2 },
};
// Builder → the roles that judge its work (must differ in model).
export const CHECKS = { "dev-coder": ["quinn-qa", "rex-reviewer"], "tara-database": ["quinn-qa", "rex-reviewer"], "ravi-integration": ["quinn-qa", "rex-reviewer"] };

// Background AI Org agents are free-model only. This pool mirrors governance/AUTONOMY_POLICY.json;
// interactive Claude/Codex sessions are separate founder tools and never appear as agent assignments.
// Scores 0-3 are working capability estimates, not benchmark claims.
export const ENGINE_MODELS = [
  { id: "free:gpt-oss-120b", name: "GPT-OSS 120B (Groq free tier)", engine: "free", model: "openai/gpt-oss-120b", cost: 0, s: { reasoning: 2, coding: 3, review: 1, writing: 2, product: 2, toolUse: 3, speed: 2 } },
  { id: "free:qwen-3.8-27b", name: "Qwen 3.8 27B (Groq free tier)", engine: "free", model: "qwen/qwen3.8-27b", cost: 0, s: { reasoning: 2, coding: 2, review: 3, writing: 2, product: 2, toolUse: 2, speed: 2 } },
];

// Read needs from a job description when the role is not in the table (any product, any custom agent).
export function needsFromText(text = "") {
  const t = text.toLowerCase(), n = {};
  const add = (k, v) => { n[k] = Math.max(n[k] || 0, v); };
  if (/product|requirement|contract|prd|user|founder/.test(t)) { add("product", 2); add("writing", 2); add("reasoning", 2); }
  if (/code|implement|build|fix|database|migration|api|integration/.test(t)) { add("coding", 3); add("toolUse", 2); }
  if (/test|qa|verify|review|audit|security/.test(t)) { add("review", 3); add("reasoning", 1); }
  if (/design|ui|ux|prototype/.test(t)) { add("product", 2); add("writing", 1); }
  if (/route|relay|status|coordinate|release|schedule/.test(t)) { add("speed", 2); }
  return Object.keys(n).length ? n : { reasoning: 1, coding: 1, speed: 1 };
}
export const score = (needs, m) => Object.entries(needs).reduce((a, [k, w]) => a + w * (m.s[k] || 0), 0) * 10 - m.cost;

// available: { [modelId]: true } — advisory local availability, not GitHub runtime evidence.
// Overrides must respect the canonical independent author/reviewer model seats.
const BUILDER_ID = "free:gpt-oss-120b", REVIEWER_ID = "free:qwen-3.8-27b";
const REVIEWERS = new Set(Object.values(CHECKS).flat());
function requiredSeatModel(slug) {
  if (Object.hasOwn(CHECKS, slug)) return BUILDER_ID;
  if (REVIEWERS.has(slug)) return REVIEWER_ID;
  return null; // other roles and custom agents remain advisory
}
export function plan({ agents, available, overrides = {} }) {
  const pool = ENGINE_MODELS.filter((m) => available[m.id]);
  const rows = [];
  for (const a of agents) {
    const needs = ROLE_NEEDS[a.slug] || needsFromText(`${a.role} ${a.description}`);
    const seat = requiredSeatModel(a.slug);
    const ranked = pool.filter(m => !seat || m.id === seat).map((m) => ({ m, sc: score(needs, m) })).sort((x, y) => y.sc - x.sc || x.m.cost - y.m.cost);
    rows.push({ ...a, needs, ranked, seat, pick: null, why: "", acceptedOverride: false });
  }
  const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
  const WORDS = { reasoning: "thinking", writing: "writing", product: "product sense", coding: "coding", toolUse: "using tools", review: "careful review", speed: "speed" };
  const top = (k) => Object.entries(k).sort((x, y) => y[1] - x[1]).slice(0, 2).map(([n]) => WORDS[n] || n).join(" and ");
  // 1) builders first (their choice constrains the checkers), then everyone else
  const order = [...rows.filter((r) => CHECKS[r.slug]), ...rows.filter((r) => !CHECKS[r.slug])];
  for (const r of order) {
    if (!r.ranked.length) {
      r.why = r.seat === REVIEWER_ID ? "Independent reviewer model unavailable; review must pause, not use the builder."
        : r.seat === BUILDER_ID ? "Approved builder model unavailable; build must pause." : "No AI connected for this agent yet.";
      continue;
    }
    const requested = overrides[r.slug];
    const ov = requested && r.ranked.find(x => x.m.id === requested)?.m;
    const builders = Object.entries(CHECKS).filter(([, checkers]) => checkers.includes(r.slug)).map(([b]) => by[b]?.pick).filter(Boolean);
    const differs = (m) => !builders.some((b) => b.id === m.id);
    if (ov && differs(ov)) { r.pick = ov; r.why = "Your choice."; r.acceptedOverride = true; }
    else {
      const pickOk = r.ranked.find((x) => differs(x.m));
      if (!pickOk) { r.why = "Independent reviewer model unavailable; review must pause."; continue; }
      r.pick = pickOk.m;
      r.why = `Best for ${top(r.needs)}${builders.length ? "; a different model from the builder, so it does not share its blind spots" : ""}.`;
      if (requested) r.why = "Override rejected (unavailable or incompatible with this seat). " + r.why;
    }
    r.fallback = r.ranked.find((x) => x.m.id !== r.pick.id && differs(x.m))?.m || null;
  }
  return rows.map(({ ranked, ...r }) => ({ slug: r.slug, name: r.name, role: r.role, needs: r.needs, pick: r.pick && { id: r.pick.id, name: r.pick.name }, fallback: r.fallback ? { id: r.fallback.id, name: r.fallback.name } : null, why: r.why, overridden: r.acceptedOverride, allowedModelIds: ranked.map(x => x.m.id) }));
}

// Parse an AI Org role file (org/agents/<slug>.md front matter).
export function parseAgent(text = "", slug = "") {
  const fm = (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
  const meta = Object.fromEntries(fm.split("\n").filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  return { slug: meta.slug || slug, name: meta.name || slug, role: meta.role || "", description: meta.description || "" };
}
