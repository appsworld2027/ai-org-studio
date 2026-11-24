// Studio data that belongs to the user, not to the Studio repo: products, provider keys, chat history.
// Lives in ~/.ai-org-studio (or $STUDIO_HOME). Keys file is readable by the user only and never sent to the browser.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export const HOME = homedir();
export const expand = (p = "") => String(p).replace(/^~(?=\/|$)/, HOME);
export const slugify = (s = "") => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "product";
export const repoOf = (s = "") => {
  const m = String(s).trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
};
export const validUrl = (u = "") => !u || /^https:\/\/[^\s/$.?#][^\s]*$/i.test(u);

export function makeStore(dir = process.env.STUDIO_HOME || join(HOME, ".ai-org-studio")) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (n) => join(dir, n);
  const readJson = (n, d) => { try { return JSON.parse(readFileSync(file(n), "utf8")); } catch { return d; } };
  const writeJson = (n, v, mode = 0o600) => { const t = file(n) + ".tmp"; writeFileSync(t, JSON.stringify(v, null, 2) + "\n", { mode }); renameSync(t, file(n)); try { chmodSync(file(n), mode); } catch { /* ok */ } };

  const products = {
    list: () => readJson("products.json", { products: [] }).products.map((p) => ({ ...p, dir: expand(p.dir) })),
    raw: () => readJson("products.json", { products: [] }).products,
    get(id) { return this.list().find((p) => p.id === id) || null; },
    save(p) {
      const all = this.raw(), i = all.findIndex((x) => x.id === p.id);
      const clean = { id: p.id, name: p.name, repo: p.repo, dir: p.dir, productionUrl: p.productionUrl || "", backlog: p.backlog || "docs/product/BACKLOG.md", prototypes: p.prototypes || [] };
      if (i >= 0) all[i] = clean; else all.push(clean);
      writeJson("products.json", { products: all }); return { ...clean, dir: expand(clean.dir) };
    },
    remove(id) { writeJson("products.json", { products: this.raw().filter((p) => p.id !== id) }); },
    freeId(base) { const ids = new Set(this.raw().map((p) => p.id)); let id = slugify(base), n = 2; while (ids.has(id)) id = `${slugify(base)}-${n++}`; return id; },
  };

  const keys = {
    all: () => readJson("keys.json", {}),
    get: (provider) => readJson("keys.json", {})[provider] || null,
    set(provider, value) { const k = readJson("keys.json", {}); if (value) k[provider] = value; else delete k[provider]; writeJson("keys.json", k, 0o600); },
  };

  const chats = {
    dir: (pid) => { const d = join(dir, "chats", slugify(pid)); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; },
    list(pid) {
      const d = this.dir(pid);
      return readdirSync(d).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => { try { const c = JSON.parse(readFileSync(join(d, f), "utf8")); return { id: c.id, title: c.title, engine: c.engine || "other", provider: c.provider, model: c.model, updatedAt: c.updatedAt }; } catch { return null; } })
        .filter(Boolean).map((c) => ({ ...c, engine: c.engine || "other" })).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    },
    get(pid, id) { if (!/^[a-z0-9-]+$/.test(id || "")) return null; try { return JSON.parse(readFileSync(join(this.dir(pid), `${id}.json`), "utf8")); } catch { return null; } },
    create(pid, { provider, model, engine = "other", effort = "", mode = "ask" }) {
      const now = new Date().toISOString();
      const c = { id: `c${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`, title: "New chat", engine, provider: provider || engine, model: model || "", effort, mode, messages: [], events: [], createdAt: now, updatedAt: now };
      this.save(pid, c); return c;
    },
    save(pid, c) { c.updatedAt = new Date().toISOString(); const t = join(this.dir(pid), `${c.id}.json.tmp`); writeFileSync(t, JSON.stringify(c), { mode: 0o600 }); renameSync(t, join(this.dir(pid), `${c.id}.json`)); },
    remove(pid, id) { if (/^[a-z0-9-]+$/.test(id || "")) rmSync(join(this.dir(pid), `${id}.json`), { force: true }); },
  };

  return { dir, products, keys, chats, readJson, writeJson };
}
