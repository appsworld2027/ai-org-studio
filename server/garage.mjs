// The Garage: one GitHub repo (studio-garage) where every AI keeps what it creates that is NOT product code
// (notes, research, plans, screenshots, reports, mockups) plus the shared MEMORY, so any AI — Claude Code, Codex,
// a free model, on any login, in any session — starts every chat knowing what happened before.
//
// Layout (one folder per product):
//   <product>/MEMORY.md        what every AI must know: goals, decisions, preferences, where things are (short, curated)
//   <product>/journal/YYYY-MM.md  one line per chat turn: date · which AI · what was asked · what was done (automatic)
//   <product>/notes|research|plans|reports|mockups|screenshots/   files the AIs create
//   <product>/INDEX.md         list of every file with its first line (automatic)
// Layer 2 (read-only here): the product repo's docs/ai-memory/* from the AI Org (product facts, reviewed by PR).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, lstatSync, appendFileSync } from "node:fs";
import { join, resolve, sep, relative, isAbsolute } from "node:path";
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
  const root = resolve(dir);
  const githubName = url => typeof url === "string" ?
    url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)?.[1] : null;
  const sameRepo = name => typeof name === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && name.toLowerCase() === repo.toLowerCase();
  // Never follow symlinks in the Garage: an index, read or redaction
  // must not consume another product's data or a host file.
  function member(base, ...parts) {
    const abs = resolve(base, ...parts);
    if (abs !== base && !abs.startsWith(base + sep)) throw new Error("Garage path escapes product");
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error("Garage path escapes root");
    let current = root;
    for (const component of ["", ...relative(root, abs).split(sep).filter(Boolean)]) {
      if (component) current = join(current, component);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error("Garage symbolic links are not allowed");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return abs;
  }
  const productDir = pid => {
    if (typeof pid !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(pid)) throw new Error("Invalid Garage product ID");
    return member(root, pid);
  };
  function assertRegularTree(base) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const abs = member(base, entry.name);
      if (entry.isDirectory()) assertRegularTree(abs);
      else if (!entry.isFile()) throw new Error("Garage only accepts regular files and directories");
    }
  }
  const ready = () => existsSync(join(root, ".git"));
  async function verifiedPushTarget({ forWrite = true } = {}) {
    try {
      const [fetch, push] = await Promise.all([
        run("git", ["-C", dir, "remote", "get-url", "--all", "origin"]),
        run("git", ["-C", dir, "remote", "get-url", "--push", "--all", "origin"])
      ]);
      const urls = [fetch, push].map(value => value.trim().split("\n"));
      if (urls.some(list => list.length !== 1 || !sameRepo(githubName(list[0])))) return null;
      const metadata = JSON.parse(await run(gh, ["api", "--hostname", "github.com", `repos/${repo}`, "--jq", "{full_name,visibility}"], { timeout: 5000 }));
      if (!sameRepo(metadata?.full_name) || metadata.visibility !== "private") return null;
      if (forWrite) {
        // A private origin does not make a downstream mirror private. The
        // Studio has no trusted GitLab visibility verifier yet, so fail closed
        // on the known active mirror workflow or missing workflow evidence.
        const response = JSON.parse(await run(gh, ["api", "--hostname", "github.com", `repos/${repo}/actions/workflows?per_page=100`, "--jq", "{total_count,workflows:[.workflows[]|{name,path,state}]}"], { timeout: 5000 }));
        if (!Number.isSafeInteger(response?.total_count) || !Array.isArray(response.workflows) ||
            response.total_count !== response.workflows.length ||
            response.workflows.some(w => typeof w?.name !== "string" || typeof w.path !== "string" || typeof w.state !== "string")) return null;
        if (response.workflows.some(w => /mirror/i.test(w.name+" "+w.path) && !["disabled_manually","disabled_inactivity","disabled_fork","deleted"].includes(w.state))) return null;
      }
      return urls[1][0];
    } catch { /* An unavailable check also blocks publication. */ }
    return null;
  }
  function ensureProduct(p) {
    const d = productDir(p.id); mkdirSync(d, { recursive: true });
    for (const f of GARAGE_FOLDERS) mkdirSync(member(d, f), { recursive: true });
    const mem = member(d, "MEMORY.md");
    if (!existsSync(mem)) writeFileSync(mem, `# ${p.name} — shared memory for every AI\n\nRead this first. Keep it short: facts that stay true. Update it when something important is decided.\n\n## Product\n- Repo: ${p.repo}\n${p.productionUrl ? `- Live app: ${p.productionUrl}\n` : ""}\n## Decisions (newest first)\n\n## Founder preferences\n\n## Where things are\n- Garage (this folder): notes/, research/, plans/, reports/, mockups/, screenshots/\n- Product memory written by the AI Org agents: docs/ai-memory/ in the product repo\n`);
    return d;
  }
  // Everything an AI needs at the start of every chat, whichever AI or login it is.
  function memoryPack(p) {
    const d = productDir(p.id), parts = [];
    const read = (f, limit) => { try { const t = readFileSync(f, "utf8"); return t.length > limit ? t.slice(0, limit) + "\n… (cut; read the file for the rest)" : t; } catch { return ""; } };
    const mem = read(member(d, "MEMORY.md"), MEMORY_LIMIT);
    if (mem) parts.push(`### Shared memory (${relative(dir, join(d, "MEMORY.md"))})\n${mem}`);
    const journals = (() => { try { return readdirSync(member(d, "journal")).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort(); } catch { return []; } })();
    const lines = journals.slice(-2).flatMap((f) => read(member(d, "journal", f), 200000).split("\n").filter((l) => l.startsWith("- ")));
    if (lines.length) parts.push(`### Recent work across all AIs (latest ${Math.min(JOURNAL_LINES, lines.length)})\n${lines.slice(-JOURNAL_LINES).join("\n")}`);
    const aiorg = (typeof p.dir === "string" && p.dir ? ["PRODUCT_BRIEF.md", "CODE_MAP.md", "TEST_KNOWLEDGE.md", "LESSONS.md"] : []).map((f) => { const t = read(join(p.dir, "docs/ai-memory", f), AIORG_LIMIT / 2); return t ? `#### docs/ai-memory/${f}\n${t}` : ""; }).filter(Boolean).join("\n\n");
    if (aiorg) parts.push(`### Product memory from the AI Org agents (read-only here; changed only through a reviewed pull request)\n${aiorg.slice(0, AIORG_LIMIT)}`);
    const index = read(member(d, "INDEX.md"), 3000);
    if (index) parts.push(`### Files in the Garage\n${index}`);
    return parts.join("\n\n");
  }
  function rules(p) {
    return `## The Garage and shared memory (every AI in this Studio follows this)
- The Garage is the folder ${productDir(p.id)} (GitHub repo ${repo || "studio-garage"}, folder ${p.id}/). Save EVERY file you create that is not product code there — never in the product repo and never in /tmp: notes/ for notes and summaries, research/ for findings, plans/ for plans and specs drafts, reports/ for test and audit reports, mockups/ for HTML/image mockups, screenshots/ for screenshots. Name files YYYY-MM-DD-short-topic.ext.
- MEMORY.md there is shared by every AI and every login (Claude, Codex, free models). When the founder decides something, states a preference, or you learn a fact that stays true, add ONE short line to MEMORY.md under the right heading (newest first). Never put keys, passwords or tokens in the Garage.
- The Studio logs one journal line per turn and syncs only to a verified private GitHub repository. Keep sensitive data out of shared memory.
- Product facts for the AI Org agents live in the product repo under docs/ai-memory/ and change only through a reviewed pull request.`;
  }
  // One line per turn, written by the Studio (not the AI) so it is always there.
  function journal(p, { engine, model, account, ask, did }) {
    ensureProduct(p);
    const t = now(), f = member(productDir(p.id), "journal", `${t.toISOString().slice(0, 7)}.md`);
    if (!existsSync(f)) writeFileSync(f, `# Journal ${t.toISOString().slice(0, 7)} — one line per AI turn\n\n`);
    const clean = (s, n) => redact(String(s || "").replace(/\s+/g, " ").trim()).text.slice(0, n);
    appendFileSync(f, `- ${t.toISOString().slice(0, 16).replace("T", " ")} · ${engine}${model ? `/${model}` : ""}${account ? ` (${account.replace(/@.*/, "@…")})` : ""} · asked: ${clean(ask, 140)} · did: ${clean(did, 220) || "—"}\n`);
  }
  function rebuildIndex(p) {
    const d = productDir(p.id), rows = [];
    const walk = (sub) => { for (const e of readdirSync(join(d, sub), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = sub ? `${sub}/${e.name}` : e.name; if (e.isSymbolicLink() || (!e.isDirectory() && !e.isFile()) || e.name.startsWith(".") || rel === "INDEX.md" || rel === "MEMORY.md" || rel.startsWith("journal")) continue;
      if (e.isDirectory()) walk(rel); else { let first = ""; if (/\.(md|txt|html?)$/i.test(e.name)) { try { first = redact(readFileSync(member(d, rel), "utf8").split("\n").find((l) => l.trim()) || "").text.replace(/^#+\s*|<[^>]+>/g, "").trim().slice(0, 90); } catch { /* binary */ } } rows.push(`- ${rel}${first ? ` — ${first}` : ""}`); } } };
    try { walk(""); } catch { return; }
    writeFileSync(member(d, "INDEX.md"), `# Garage index — ${p.name} (automatic)\n\n${rows.join("\n") || "(empty)"}\n`);
  }
  // Redact secrets in changed text files, rebuild the index, commit and push. Never blocks the chat.
  let saving = Promise.resolve();
  function save(p, message) {
    saving = saving.then(async () => {
      if (!ready()) return { ok: false, reason: "garage not set up" };
      const product = ensureProduct(p);
      assertRegularTree(product);
      rebuildIndex(p);
      const target = await verifiedPushTarget();
      if (!target) {
        const reason = "Garage sync blocked: origin must resolve to the exact configured private GitHub repository with no unverified active mirror";
        log(reason);
        return { ok: false, pushed: false, reason };
      }
      const records = (await run("git", ["-C", dir, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", p.id])).split("\0").filter(Boolean);
      const changed = [];
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        if (row.length < 4 || row[2] !== " ") throw new Error("Invalid Garage status receipt");
        changed.push(row.slice(3));
        if (/[RC]/.test(row.slice(0, 2))) i++; // -z: destination first, then original path
      }
      let redacted = 0;
      for (const f of changed) { const abs = member(root, f); try { if (!/\.(md|txt|html?|json|csv|ya?ml|js|ts|tsx|sql|sh|log)$/i.test(f) || statSync(abs).size > 2_000_000) continue; const r = redact(readFileSync(abs, "utf8")); if (r.count) { writeFileSync(abs, r.text); redacted += r.count; } } catch { /* gone */ } }
      if (changed.length) {
        await run("git", ["-C", dir, "add", "-A", "--", p.id]);
        await run("git", ["-C", dir, "-c", "user.name=AI Org Studio", "-c", "user.email=studio@users.noreply.github.com", "commit", "-q", "-m", redact(message).text.slice(0, 200), "--only", "--", p.id]);
      }
      // A prior save can have committed locally but failed to push. Always attempt
      // publication after verification, even when the current working tree is clean.
      const pending = reason => {
        log(reason);
        return { ok: false, changed: changed.length, pushed: false, redacted, reason };
      };
      if (redacted) log(`garage: removed ${redacted} secret-looking value(s) before saving`);
      if (await verifiedPushTarget() !== target) return pending("Garage sync blocked: privacy verification changed; local checkpoint retained.");
      const push = () => run("git", ["-C", dir, "push", "-q", target, "HEAD"]);
      try { await push(); }
      catch {
        // A concurrent push or outage must never silently resolve competing founder
        // decisions. Retry only from a clean worktree, and abort a rebase we started.
        const rebaseInProgress = async () => {
          for (const name of ["rebase-merge", "rebase-apply"]) {
            const path = (await run("git", ["-C", dir, "rev-parse", "--git-path", name])).trim();
            if (existsSync(isAbsolute(path) ? path : join(dir, path))) return true;
          }
          return false;
        };
        if (await rebaseInProgress() || (await run("git", ["-C", dir, "status", "--porcelain"])).trim()) {
          return pending("Garage sync pending: existing edits or rebase require reconciliation; local checkpoint retained.");
        }
        if (await verifiedPushTarget() !== target) return pending("Garage sync blocked: privacy verification changed; local checkpoint retained.");
        try { await run("git", ["-C", dir, "pull", "-q", "--rebase", target, "HEAD"]); }
        catch {
          if (await rebaseInProgress()) {
            try { await run("git", ["-C", dir, "rebase", "--abort"]); }
            catch { return pending("Garage rebase failed and could not be aborted; preserve working tree for recovery."); }
          }
          return pending("Garage sync pending: rebase conflict or network failure; local checkpoint retained, remote unchanged.");
        }
        if (await verifiedPushTarget() !== target) return pending("Garage sync blocked: privacy verification changed; local checkpoint retained.");
        try { await push(); }
        catch { return pending("Garage sync pending: retry failed; local checkpoint retained."); }
      }
      return { ok: true, changed: changed.length, pushed: true, redacted };
    }).catch((e) => { log(`garage: ${e.message}`); return { ok: false, pushed: false, reason: e.message }; });
    return saving;
  }
  // Pull at chat start so memory written from another machine or AI is there.
  async function pull() {
    if (!ready()) return { ok: false, reason: "garage not set up" };
    const target = await verifiedPushTarget({ forWrite: false });
    if (!target) return { ok: false, reason: "Garage pull blocked: origin must resolve to the exact configured private GitHub repository" };
    try { await run("git", ["-C", dir, "pull", "-q", "--rebase", "--autostash", target, "HEAD"]); return { ok: true }; }
    catch (e) { log(`garage: pull skipped (${e.message})`); return { ok: false, reason: e.message }; }
  }
  function files(p) {
    const d = productDir(p.id), out = [];
    const walk = (sub) => { let ents = []; try { ents = readdirSync(join(d, sub), { withFileTypes: true }); } catch { return; } for (const e of ents) { const rel = sub ? `${sub}/${e.name}` : e.name; if (e.name.startsWith(".") || e.isSymbolicLink()) continue; if (e.isDirectory()) walk(rel); else if (e.isFile()) { const st = statSync(member(d, rel)); out.push({ path: rel, size: st.size, modified: st.mtime.toISOString() }); } } };
    walk(""); return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }
  function readFile(p, rel) {
    const d = productDir(p.id);
    if (typeof rel !== "string" || !rel || rel.includes("..") || isAbsolute(rel)) throw new Error("bad path");
    const abs = member(d, rel);
    if (!lstatSync(abs).isFile()) throw new Error("bad path");
    return readFileSync(abs);
  }
  // The agent→model plan from the Studio's Team table, published for the AI Org router to read (no shared files edited).
  function publishTeam(p, plan) {
    if (!ready()) return; ensureProduct(p);
    const rows = (plan.rows || []).map((r) => ({ agent: r.slug, name: r.name, model: r.pick?.id || null, backup: r.fallback?.id || null, why: r.why }));
    const f = member(productDir(p.id), "team-models.json"), body = JSON.stringify({ product: p.id, updated: now().toISOString().slice(0, 10), note: "Written by AI Org Studio (Team table). The AI Org router may read this to pick each agent's model.", agents: rows }, null, 2) + "\n";
    let old = ""; try { old = readFileSync(f, "utf8"); } catch { /* new */ }
    if (old.replace(/"updated": "[^"]+"/, "") !== body.replace(/"updated": "[^"]+"/, "")) writeFileSync(f, body);
  }
  return { dir, repo, ready, ensureProduct, publishTeam, productDir, memoryPack, rules, journal, save, pull, files, readFile, rebuildIndex };
}
