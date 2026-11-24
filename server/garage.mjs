// The Garage: one private GitHub repo (studio-garage) where every AI keeps what it creates that is NOT product code
// (notes, research, plans, screenshots, reports, mockups) plus the shared MEMORY, so any AI — Claude Code, Codex,
// a free model, on any login, in any session — starts every chat knowing what happened before.
//
// Layout (one folder per product):
//   <product>/MEMORY.md        what every AI must know: goals, decisions, preferences, where things are (short, curated)
//   <product>/journal/YYYY-MM.md  one line per chat turn: date · which AI · what was asked · what was done (automatic)
//   <product>/notes|research|plans|reports|mockups|screenshots/   files the AIs create
//   <product>/INDEX.md         list of every file with its first line (automatic)
// Layer 2 (read-only here): the product repo's docs/ai-memory/* from the AI Org (product facts, reviewed by PR).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";

export const GARAGE_FOLDERS = ["notes", "research", "plans", "reports", "mockups", "screenshots", "journal"];
const MEMORY_LIMIT = 9000, JOURNAL_LINES = 25, AIORG_LIMIT = 6000;

// Secrets must never reach GitHub. Lines that look like keys are replaced before every save.
const SECRET_RES = [
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})/g, /\b(gh[pousr]_[A-Za-z0-9]{30,})/g, /\b(github_pat_[A-Za-z0-9_]{40,})/g, /\b(sbp_[A-Za-z0-9]{30,})/g,
  /\b(ntn_[A-Za-z0-9]{30,})/g, /\b(figd_[A-Za-z0-9_-]{30,})/g, /\b(sntry[su]_[A-Za-z0-9_+/=-]{30,})/g, /\b(xox[abpr]-[A-Za-z0-9-]{20,})/g, /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b((?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?)([A-Za-z0-9_\-+/=]{16,})/gi,
];
export function redact(text = "") {
  let s = String(text), n = 0;
  for (const re of SECRET_RES) s = s.replace(re, (m, a, b) => { n++; return b !== undefined && typeof b === "string" && /[:=]/.test(a) ? `${a}[REDACTED]` : "[REDACTED]"; });
  return { text: s, count: n };
}

const run = (cmd, args, opts = {}) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 120000, maxBuffer: 16 << 20, ...opts }, (e, out, err) => (e ? fail(new Error(String(err || e.message).trim().split("\n").slice(-1)[0])) : ok(String(out)))));

export function makeGarage({ dir, repo = "", gh = "gh", log = () => {}, now = () => new Date() }) {
  // The repo name (owner/name) from the folder's own git settings when not given.
  if (!repo) { try { const m = readFileSync(join(dir, ".git/config"), "utf8").match(/url\s*=\s*(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)(?:\.git)?\s*$/m); if (m) repo = m[1]; } catch { /* not set up */ } }
  const productDir = (pid) => join(dir, pid);
  const ready = () => existsSync(join(dir, ".git"));
  function ensureProduct(p) {
    const d = productDir(p.id); mkdirSync(d, { recursive: true });
    for (const f of GARAGE_FOLDERS) mkdirSync(join(d, f), { recursive: true });
    const mem = join(d, "MEMORY.md");
    if (!existsSync(mem)) writeFileSync(mem, `# ${p.name} — shared memory for every AI\n\nRead this first. Keep it short: facts that stay true. Update it when something important is decided.\n\n## Product\n- Repo: ${p.repo}\n${p.productionUrl ? `- Live app: ${p.productionUrl}\n` : ""}\n## Decisions (newest first)\n\n## Founder preferences\n\n## Where things are\n- Garage (this folder): notes/, research/, plans/, reports/, mockups/, screenshots/\n- Product memory written by the AI Org agents: docs/ai-memory/ in the product repo\n`);
    return d;
  }
  // Everything an AI needs at the start of every chat, whichever AI or login it is.
  function memoryPack(p) {
    const d = productDir(p.id), parts = [];
    const read = (f, limit) => { try { const t = readFileSync(f, "utf8"); return t.length > limit ? t.slice(0, limit) + "\n… (cut; read the file for the rest)" : t; } catch { return ""; } };
    const mem = read(join(d, "MEMORY.md"), MEMORY_LIMIT);
    if (mem) parts.push(`### Shared memory (${relative(dir, join(d, "MEMORY.md"))})\n${mem}`);
    const journals = (() => { try { return readdirSync(join(d, "journal")).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort(); } catch { return []; } })();
    const lines = journals.slice(-2).flatMap((f) => read(join(d, "journal", f), 200000).split("\n").filter((l) => l.startsWith("- ")));
    if (lines.length) parts.push(`### Recent work across all AIs (latest ${Math.min(JOURNAL_LINES, lines.length)})\n${lines.slice(-JOURNAL_LINES).join("\n")}`);
    const aiorg = ["PRODUCT_BRIEF.md", "CODE_MAP.md", "TEST_KNOWLEDGE.md", "LESSONS.md"].map((f) => { const t = read(join(p.dir, "docs/ai-memory", f), AIORG_LIMIT / 2); return t ? `#### docs/ai-memory/${f}\n${t}` : ""; }).filter(Boolean).join("\n\n");
    if (aiorg) parts.push(`### Product memory from the AI Org agents (read-only here; changed only through a reviewed pull request)\n${aiorg.slice(0, AIORG_LIMIT)}`);
    const index = read(join(d, "INDEX.md"), 3000);
    if (index) parts.push(`### Files in the Garage\n${index}`);
    return parts.join("\n\n");
  }
  function rules(p) {
    return `## The Garage and shared memory (every AI in this Studio follows this)
- The Garage is the folder ${productDir(p.id)} (private GitHub repo ${repo || "studio-garage"}, folder ${p.id}/). Save EVERY file you create that is not product code there — never in the product repo and never in /tmp: notes/ for notes and summaries, research/ for findings, plans/ for plans and specs drafts, reports/ for test and audit reports, mockups/ for HTML/image mockups, screenshots/ for screenshots. Name files YYYY-MM-DD-short-topic.ext.
- MEMORY.md there is shared by every AI and every login (Claude, Codex, free models). When the founder decides something, states a preference, or you learn a fact that stays true, add ONE short line to MEMORY.md under the right heading (newest first). Never put keys, passwords or tokens in the Garage.
- The Studio saves the Garage to GitHub automatically after every reply and logs one journal line per turn; you do not need to commit it.
- Product facts for the AI Org agents live in the product repo under docs/ai-memory/ and change only through a reviewed pull request.`;
  }
  // One line per turn, written by the Studio (not the AI) so it is always there.
  function journal(p, { engine, model, account, ask, did }) {
    ensureProduct(p);
    const t = now(), f = join(productDir(p.id), "journal", `${t.toISOString().slice(0, 7)}.md`);
    if (!existsSync(f)) writeFileSync(f, `# Journal ${t.toISOString().slice(0, 7)} — one line per AI turn\n\n`);
    const clean = (s, n) => redact(String(s || "").replace(/\s+/g, " ").trim()).text.slice(0, n);
    appendFileSync(f, `- ${t.toISOString().slice(0, 16).replace("T", " ")} · ${engine}${model ? `/${model}` : ""}${account ? ` (${account.replace(/@.*/, "@…")})` : ""} · asked: ${clean(ask, 140)} · did: ${clean(did, 220) || "—"}\n`);
  }
  function rebuildIndex(p) {
    const d = productDir(p.id), rows = [];
    const walk = (sub) => { for (const e of readdirSync(join(d, sub), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = sub ? `${sub}/${e.name}` : e.name; if (e.name.startsWith(".") || rel === "INDEX.md" || rel === "MEMORY.md" || rel.startsWith("journal")) continue;
      if (e.isDirectory()) walk(rel); else { let first = ""; if (/\.(md|txt|html?)$/i.test(e.name)) { try { first = readFileSync(join(d, rel), "utf8").split("\n").find((l) => l.trim())?.replace(/^#+\s*|<[^>]+>/g, "").trim().slice(0, 90) || ""; } catch { /* binary */ } } rows.push(`- ${rel}${first ? ` — ${first}` : ""}`); } } };
    try { walk(""); } catch { return; }
    writeFileSync(join(d, "INDEX.md"), `# Garage index — ${p.name} (automatic)\n\n${rows.join("\n") || "(empty)"}\n`);
  }
  // Redact secrets in changed text files, rebuild the index, commit and push. Never blocks the chat.
  let saving = Promise.resolve();
  function save(p, message) {
    saving = saving.then(async () => {
      if (!ready()) return { ok: false, reason: "garage not set up" };
      ensureProduct(p); rebuildIndex(p);
      const changed = (await run("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all", "--", p.id]).catch(() => "")).split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ""));
      let redacted = 0;
      for (const f of changed) { const abs = join(dir, f); try { if (!/\.(md|txt|html?|json|csv|ya?ml|js|ts|tsx|sql|sh|log)$/i.test(f) || statSync(abs).size > 2_000_000) continue; const r = redact(readFileSync(abs, "utf8")); if (r.count) { writeFileSync(abs, r.text); redacted += r.count; } } catch { /* gone */ } }
      if (!changed.length) return { ok: true, changed: 0 };
      await run("git", ["-C", dir, "add", "-A", "--", p.id]);
      await run("git", ["-C", dir, "-c", "user.name=AI Org Studio", "-c", "user.email=studio@users.noreply.github.com", "commit", "-q", "-m", redact(message).text.slice(0, 200)]).catch(() => "");
      const pushed = await run("git", ["-C", dir, "push", "-q", "origin", "HEAD"]).then(() => true).catch(async (e) => {
        // Another machine pushed first: take theirs, keep ours, try once more.
        await run("git", ["-C", dir, "pull", "-q", "--rebase", "-X", "theirs", "origin", "HEAD"]).catch(() => "");
        return run("git", ["-C", dir, "push", "-q", "origin", "HEAD"]).then(() => true).catch(() => { log(`garage: push failed (${e.message}); will retry next save`); return false; });
      });
      if (redacted) log(`garage: removed ${redacted} secret-looking value(s) before saving`);
      return { ok: true, changed: changed.length, pushed, redacted };
    }).catch((e) => { log(`garage: ${e.message}`); return { ok: false, reason: e.message }; });
    return saving;
  }
  // Pull at chat start so memory written from another machine or AI is there.
  async function pull() { if (ready()) await run("git", ["-C", dir, "pull", "-q", "--rebase", "--autostash", "origin", "HEAD"]).catch((e) => log(`garage: pull skipped (${e.message})`)); }
  function files(p) {
    const d = productDir(p.id), out = [];
    const walk = (sub) => { let ents = []; try { ents = readdirSync(join(d, sub), { withFileTypes: true }); } catch { return; } for (const e of ents) { const rel = sub ? `${sub}/${e.name}` : e.name; if (e.name.startsWith(".")) continue; if (e.isDirectory()) walk(rel); else { const st = statSync(join(d, rel)); out.push({ path: rel, size: st.size, modified: st.mtime.toISOString() }); } } };
    walk(""); return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }
  function readFile(p, rel) {
    const d = productDir(p.id), abs = join(d, rel);
    if (!rel || rel.includes("..") || !abs.startsWith(d + "/")) throw new Error("bad path");
    return readFileSync(abs);
  }
  // The agent→model plan from the Studio's Team table, published for the AI Org router to read (no shared files edited).
  function publishTeam(p, plan) {
    if (!ready()) return; ensureProduct(p);
    const rows = (plan.rows || []).map((r) => ({ agent: r.slug, name: r.name, model: r.pick?.id || null, backup: r.fallback?.id || null, why: r.why }));
    const f = join(productDir(p.id), "team-models.json"), body = JSON.stringify({ product: p.id, updated: now().toISOString().slice(0, 10), note: "Written by AI Org Studio (Team table). The AI Org router may read this to pick each agent's model.", agents: rows }, null, 2) + "\n";
    let old = ""; try { old = readFileSync(f, "utf8"); } catch { /* new */ }
    if (old.replace(/"updated": "[^"]+"/, "") !== body.replace(/"updated": "[^"]+"/, "")) writeFileSync(f, body);
  }
  return { dir, repo, ready, ensureProduct, publishTeam, productDir, memoryPack, rules, journal, save, pull, files, readFile, rebuildIndex };
}
