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

// Which AI engine ran (or is running) an agents-workflow job, read from its step names. Never guessed: no match means "Unknown".
export function toolFromSteps(steps = []) {
  const s = steps.find((x) => /^Run agent with/i.test(x.name || "") && x.conclusion !== "skipped" && x.status !== "pending");
  if (!s) return "Unknown";
  if (/free engine/i.test(s.name)) return "Free engine (NVIDIA NIM)";
  if (/codex/i.test(s.name)) return "Codex";
  if (/claude code/i.test(s.name)) return "Claude Code (GitHub Actions)";
  return "Unknown";
}

export const ROSTER = [["Maya", "AI Product Manager"], ["Arjun", "AI CPTO"], ["Iris", "Product Designer"], ["Kiran", "Project Manager A"], ["Leela", "Project Manager B"],
  ["Dev", "Coding Specialist"], ["Tara", "Database Specialist"], ["Ravi", "Integration Specialist"], ["Quinn", "QA Specialist"], ["Rex", "Code Reviewer"], ["Sam", "Release & DevOps"]];

// One row per AI Org agent: what it is doing now, on which feature and tool, and its last visible action.
export function rosterFrom({ rows = [], working = [], comments = [], now = Date.now() }) {
  return ROSTER.map(([name, role]) => {
    const w = working.find((x) => (x.who || "").startsWith(name));
    const row = rows.find((r) => (r.kind === "agent" || r.kind === "loop") && (r.who || "").startsWith(name));
    const c = comments.find((x) => new RegExp(`^\\**\\[${name}\\s+[—-]`).test((x.body || "").trim()));
    const last = c ? { at: c.created_at, url: c.html_url, via: c.user?.login === "github-actions[bot]" ? "GitHub Actions" : "Studio / chat",
      text: (c.body || "").replace(/^\**\[[^\]]+\]\**/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/[#*`>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 110) } : null;
    return { name, role, state: w ? "working" : row ? "assigned" : "idle", feature: w?.what || row?.title || "", tool: w?.tool || "", minutes: w?.minutes ?? null, url: w?.url || "", last };
  });
}

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
export function buildBoard({ backlog = [], issues = [], runs = [], previews = {}, jobs = {}, checks = {}, now = Date.now() }) {
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
    const tool = toolFromSteps(jobs[r.id]);
    if (row && row.kind === "agent") working.push({ who: row.who, what: row.title, minutes: mins, url: r.html_url, tool });
    else if (r.event === "schedule") working.push({ who: "AI Org loop", what: "hourly check of every open item", minutes: mins, url: r.html_url, tool: toolFromSteps(jobs[r.id]) });
    else {
      // Started by the loop or by hand: the run title does not say which item. Name the candidates honestly.
      const busy = [...rows.values()].filter((x) => x.kind === "agent");
      const what = busy.length === 1 ? busy[0].title : busy.length ? `one of: ${busy.map((x) => x.who.split(",")[0]).join(", ")}` : (r.display_title && r.display_title !== r.name ? r.display_title : "an AI Org step");
      working.push({ who: busy.length === 1 ? busy[0].who : "An AI agent", what, minutes: mins, url: r.html_url, tool: toolFromSteps(jobs[r.id]) });
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
  // Tests and deployment per feature: check runs on its pull request, and its preview link.
  for (const row of rows.values()) {
    const pr = row.items.find((i) => i.isPR && i.commit);
    const cs = pr ? checks[pr.commit] || [] : [];
    row.tests = pr && cs.length ? { total: cs.length, passed: cs.filter((c) => c.conclusion === "success").length, failed: cs.filter((c) => ["failure", "cancelled", "timed_out"].includes(c.conclusion)).length, running: cs.filter((c) => c.status !== "completed").length, url: pr.url } : null;
    row.deploy = row.items.map((i) => previews[i.branch]).find(Boolean) || previews[`ai/contract-${row.slug}`] || null;
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
  // Recently finished agent runs: who ran on which tool and how it ended.
  const recent = runs.filter((r) => r.status === "completed" && /AI agents/i.test(r.name || "") && !(r.event === "schedule" && toolFromSteps(jobs[r.id]) === "Unknown")).slice(0, 8).map((r) => ({
    title: r.display_title || r.name, event: r.event, conclusion: r.conclusion, tool: toolFromSteps(jobs[r.id]), at: r.updated_at || r.created_at, url: r.html_url }));
  const idleChecks = runs.filter((r) => r.status === "completed" && r.event === "schedule" && /AI agents/i.test(r.name || "") && toolFromSteps(jobs[r.id]) === "Unknown").length;
  return { overview, decisions, quality, recent, idleChecks, stages: STAGES, rows: list, working, waiting, demo, next: next ? { slug: next.slug, title: next.title } : null };
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

// Read-only evidence from GitHub's actual runs/jobs/steps. A label, a title,
// a successful workflow, or a successful chain step alone cannot prove that
// the next agent received the same artifact. Keep those claims separate.
export const isAgentEvidenceRun = r => /AI agents|Agent worker|Safe trial|QA lab/i.test(r.name || "");
export function workflowEvidenceFrom(runs = [], jobDetails = {}) {
  return runs.filter(isAgentEvidenceRun).slice(0, 8).map(r => {
    const available = Array.isArray(jobDetails[r.id]);
    const js = available ? jobDetails[r.id] : [];
    const steps = js.flatMap(j => (j.steps || []).filter(s =>
      /Route|Onboarding pack|Run agent with|Handover check|Save agent logs|Chain to the next agent|Acceptance-test gate|Build with the free|Review with the free|Grade on a clean/i.test(s.name || "")).
      map(s => ({ job: j.name, name: s.name, status: s.status || "unknown", conclusion: s.conclusion || null,
        startedAt: s.started_at || null, completedAt: s.completed_at || null,
        url: j.html_url || r.html_url })));
    return { runId: r.id, attempt: r.run_attempt || null, name: r.name, title: r.display_title || r.name,
      status: r.status, conclusion: r.conclusion || null, commit: r.head_sha || null,
      url: r.html_url, updatedAt: r.updated_at || null, jobsAvailable: available,
      jobs: js.map(j => ({ name: j.name, status: j.status, conclusion: j.conclusion || null, url: j.html_url || r.html_url })),
      steps,
      engineActive: steps.some(s => /Run agent with|Build with the free|Review with the free/i.test(s.name) && s.status === "in_progress"),
      handoverCheck: steps.find(s => /Handover check/i.test(s.name))?.conclusion || null,
      // Even a successful chain step is not a receipt from a downstream agent.
      downstreamReceiptVerified: false };
  });
}
