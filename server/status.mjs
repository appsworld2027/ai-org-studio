// Pure logic for the Studio's right-hand panel: turns GitHub data into "which agent is doing what".
// No network calls here, so every rule is unit-tested (test/status.test.mjs).

// Stages a feature moves through, in order. Labels come from the AI Org loop (playbooks/loop.md).
export const STAGES = [
  { id: "idea", name: "Idea" },
  { id: "contract", name: "Contract" },
  { id: "approve", name: "Your OK" },
  { id: "tests", name: "Tests" },
  { id: "build", name: "Build" },
  { id: "qa", name: "QA + review" },
  { id: "demo", name: "Demo" },
  { id: "shipped", name: "Shipped" },
];

// label -> [stage id, who acts, "agent" | "founder" | "loop" | "blocked"]
const LABEL_STAGE = {
  "ai:discovery": ["contract", "Maya, product manager", "agent"],
  "ai:founder-decision": ["approve", "You", "founder"],
  "ai:tests": ["tests", "Quinn, tester", "agent"],
  "ai:contract": ["build", "Loop controller", "loop"],
  "ai:build": ["build", "Dev, builder", "agent"],
  "ai:fix": ["qa", "Dev, builder (fixing)", "agent"],
  "ai:qa": ["qa", "Quinn, tester", "agent"],
  "ai:review": ["qa", "Rex, reviewer", "agent"],
  "ai:delivery": ["demo", "Loop controller", "loop"],
  "ai:release": ["demo", "Sam, release checks", "loop"],
  "ai:founder-test": ["demo", "You", "founder"],
  "ai:blocked": [null, "Needs a decision", "blocked"],
};
// When several labels are present, the later stage wins; blocked always wins.
const ORDER = ["ai:discovery", "ai:founder-decision", "ai:tests", "ai:contract", "ai:build", "ai:fix", "ai:qa", "ai:review", "ai:delivery", "ai:release", "ai:founder-test", "ai:blocked"];

export const slugOf = (s = "") => (s.match(/\[([a-z0-9-]+)\]\s*$/) || s.match(/^ai\/(?:contract|build|fix)-([a-z0-9-]+?)(?:-\d+)?$/) || [])[1] || null;

export function parseBacklog(md = "") {
  const items = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*([a-z0-9-]+)\s*[—-]+\s*(.+?)(?:\s*[—-]+\s*([A-Z0-9-]+))?\s*$/);
    if (m) items.push({ slug: m[2], title: m[3].trim(), ref: m[4] || "", done: m[1].toLowerCase() === "x" });
  }
  return items;
}

export function stageOf(labels = []) {
  const ai = labels.filter((l) => LABEL_STAGE[l]).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!ai.length) return null;
  const top = ai.includes("ai:blocked") ? "ai:blocked" : ai.at(-1);
  const [stage, who, kind] = LABEL_STAGE[top];
  return { label: top, stage, who, kind };
}

// Builds the board: one row per backlog feature plus any loop item not on the backlog.
// issues: GitHub issues+PRs (REST shape); runs: workflow runs; previews: { [branch]: url }.
export function buildBoard({ backlog = [], issues = [], runs = [], previews = {}, now = Date.now() }) {
  const rows = new Map();
  for (const b of backlog) rows.set(b.slug, { slug: b.slug, title: b.title, ref: b.ref, stage: b.done ? "shipped" : "idea", who: b.done ? "Shipped" : "Queued", kind: b.done ? "done" : "queued", items: [] });
  const loopItems = issues.filter((i) => (i.labels || []).some((l) => String(l.name || l).startsWith("ai:")));
  for (const it of loopItems) {
    const labels = it.labels.map((l) => l.name || l);
    const slug = slugOf(it.title) || slugOf(it.pull_request ? it.branch || it.head?.ref || "" : "") || `item-${it.number}`;
    const st = stageOf(labels);
    if (!st) continue;
    const row = rows.get(slug) || { slug, title: it.title.replace(/\s*\[[a-z0-9-]+\]\s*$/, ""), ref: "", stage: "idea", who: "", kind: "queued", items: [] };
    row.items.push({ number: it.number, title: it.title, isPR: !!it.pull_request, url: it.html_url, branch: it.branch || it.head?.ref || "", commit: it.head?.sha || null, assignees: (it.assignees || []).map((a) => a.login), labels, ...st });
    // The row shows the furthest-along item; blocked overrides.
    const rank = (s) => STAGES.findIndex((x) => x.id === s);
    if (st.kind === "blocked") Object.assign(row, { stage: row.stage, who: st.who, kind: "blocked" });
    else if (row.kind !== "blocked" && (row.kind === "queued" || rank(st.stage) >= rank(row.stage))) Object.assign(row, { stage: st.stage, who: st.who, kind: st.kind });
    rows.set(slug, row);
  }
  // Agents running right now: in-progress runs of the agents workflow, matched to items by title.
  const active = runs.filter((r) => r.status !== "completed" && /AI agents/i.test(r.name || ""));
  const working = [];
  for (const r of active) {
    const mins = Math.max(0, Math.round((now - Date.parse(r.run_started_at || r.created_at)) / 60000));
    const row = [...rows.values()].find((x) => x.items.some((i) => r.display_title && (r.display_title === i.title || r.display_title.includes(`#${i.number}`))));
    if (row && row.kind === "agent") working.push({ who: row.who, what: row.title, minutes: mins, url: r.html_url });
    else if (r.event === "schedule") working.push({ who: "AI Org loop", what: "hourly check of every open item", minutes: mins, url: r.html_url });
    else {
      // Started by the loop or by hand: the run title does not say which item. Name the candidates honestly.
      const busy = [...rows.values()].filter((x) => x.kind === "agent");
      const what = busy.length === 1 ? busy[0].title : busy.length ? `one of: ${busy.map((x) => x.who.split(",")[0]).join(", ")}` : (r.display_title && r.display_title !== r.name ? r.display_title : "an AI Org step");
      working.push({ who: busy.length === 1 ? busy[0].who : "An AI agent", what, minutes: mins, url: r.html_url });
    }
  }
  const qa = runs.find((r) => r.status !== "completed" && /QA lab/i.test(r.name || ""));
  if (qa) working.push({ who: "QA lab", what: "1,000 personas", minutes: Math.max(0, Math.round((now - Date.parse(qa.run_started_at || qa.created_at)) / 60000)), url: qa.html_url });
  // Demo Pack preview: a founder-test PR whose branch has a preview URL.
  let demo = null;
  for (const row of rows.values()) for (const i of row.items) if (i.labels.includes("ai:founder-test") && i.isPR) {
    const url = previews[i.branch] || previews[`ai/contract-${row.slug}`];
    if (url) demo = { feature: row.title, url, number: i.number };
  }
  const list = [...rows.values()];
  const waiting = list.filter((r) => r.kind === "founder");
  const next = backlog.find((b) => !b.done && !list.some((r) => r.slug === b.slug && r.kind !== "queued"));
  const decisions = list.flatMap((row) => row.items.filter((item) => item.labels.includes("ai:founder-decision") && !item.labels.includes("ai:blocked")));
  const quality = runs.filter((run) => run.status === "completed" && /quality|checks|qa|acceptance|verif/i.test(run.name || "")).slice(0, 6)
    .map((run) => ({ name: run.name, conclusion: run.conclusion, commit: run.head_sha, url: run.html_url }));
  const overview = {
    completed: list.filter((row) => row.kind === "done").length,
    blocked: list.filter((row) => row.kind === "blocked").length,
    upcoming: list.filter((row) => row.kind === "queued").length,
    ongoing: list.filter((row) => ["agent", "loop", "founder"].includes(row.kind)).length,
  };
  return { overview, decisions, quality, stages: STAGES, rows: list, working, waiting, demo, next: next ? { slug: next.slug, title: next.title } : null };
}

// Feed lines from recent comments, newest first, in plain language.
export function feedFrom(comments = [], limit = 8) {
  const out = [];
  for (const c of comments) {
    const body = (c.body || "").trim();
    if (!body || /^\[vc\]:/.test(body) || c.user?.login === "vercel[bot]") continue;
    const n = (c.issue_url || "").split("/").pop();
    const agent = body.match(/^\**\[([A-Z][a-z]+)\s+[—-]\s+([^\]]+)\]\**/);
    let text;
    if (agent) {
      const rest = body.slice(agent[0].length).replace(/<!--[\s\S]*?-->/g, "").replace(/[#*`>|]/g, " ").replace(/\s+/g, " ").trim();
      text = `${agent[1]}: ${rest.slice(0, 140)}${rest.length > 140 ? "…" : ""}`;
    } else if (/^\/(approve|changes|next|stop)/i.test(body)) {
      const cmd = body.match(/^\/(\w+)/)[1].toLowerCase();
      text = { approve: "You approved", changes: "You asked for changes", next: "You asked for the next feature", stop: "You stopped the item" }[cmd];
    } else continue;
    out.push({ actor: c.user?.login || null, at: c.created_at, number: Number(n) || null, text, url: c.html_url });
    if (out.length >= limit) break;
  }
  return out;
}

// Picks what the "Real app" tab should show.
export function appTarget({ productionUrl = "", demo = null }) {
  if (demo?.url) return { kind: "preview", url: demo.url, label: `Preview: ${demo.feature}` };
  if (productionUrl) return { kind: "production", url: productionUrl, label: "Production" };
  return { kind: "none", url: "", label: "No Vercel deployment yet" };
}
