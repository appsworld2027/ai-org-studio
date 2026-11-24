// Attachments for the Claude Code / Codex composer. Files are saved inside the product folder under .studio-uploads/
// (excluded from git locally via .git/info/exclude, never committed) so the official program reads them by path.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
export const UPLOAD_DIR = ".studio-uploads", UPLOAD_MAX = 20 << 20, UPLOAD_KEEP = 200;
const UPLOAD_EXT = /\.(png|jpe?g|gif|webp|pdf|txt|md|csv|tsv|json|ya?ml|xml|html?|css|js|mjs|cjs|jsx|ts|tsx|py|rb|go|java|kt|swift|sql|log|docx|xlsx|pptx|svg)$/i;
export function safeUploadName(n = "") {
  const base = String(n).split(/[\\/]/).pop().normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-80);
  return base && UPLOAD_EXT.test(base) ? base : "";
}
export const readRaw = (req, limit) => new Promise((ok, fail) => { const parts = []; let n = 0; req.on("data", (c) => { n += c.length; if (n > limit) { fail(new Error("too large")); req.destroy(); } else parts.push(c); }); req.on("end", () => ok(Buffer.concat(parts))); req.on("error", fail); });
export function ensureIgnored(dir) {
  // Local-only exclude: the repo's own .gitignore is never changed.
  try { const ex = join(dir, ".git/info/exclude"); const t = existsSync(ex) ? readFileSync(ex, "utf8") : ""; if (!t.includes(`${UPLOAD_DIR}/`)) writeFileSync(ex, `${t}${t && !t.endsWith("\n") ? "\n" : ""}${UPLOAD_DIR}/\n`); } catch { /* not a git repo */ }
}
export function pruneUploads(dir) {
  try { const f = readdirSync(dir).sort(); for (const x of f.slice(0, Math.max(0, f.length - UPLOAD_KEEP))) rmSync(join(dir, x), { force: true }); } catch { /* ok */ }
}
