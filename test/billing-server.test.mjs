// Starts the real server with the default (no paid APIs) settings and tries to get around the block.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let deps = true; try { await import("ws"); await import("node-pty"); } catch { deps = false; }
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); }); });

test("server default: blocked providers and bypass attempts are refused; launched apps get no paid keys", { skip: !deps && "ws / node-pty not installed" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "bill-srv-")), port = await freePort(), seen = join(home, "seen.txt"), fake = join(home, "fake-app.sh");
  writeFileSync(fake, `#!/bin/sh\nenv > '${seen}'\n`); chmodSync(fake, 0o755);
  const env = { ...process.env, HOME: home, STUDIO_HOME: home, STUDIO_GARAGE: join(home, "g"), STUDIO_CONFIG: join(home, "none"), STUDIO_PORT: String(port), STUDIO_HOST: "127.0.0.1", STUDIO_TOKEN: "t", ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-test" };
  delete env.STUDIO_ALLOW_PAID_APIS;
  const server = spawn(process.execPath, [join(ROOT, "server/server.mjs")], { env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const call = (method, path, body) => fetch(base + path, { method, headers: { Cookie: "studio_key=t", Origin: base, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  try {
    let cfg; for (let i = 0; i < 100 && !cfg; i++) { try { cfg = await (await call("GET", "/api/config")).json(); } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.deepEqual(cfg.providers.map((p) => p.id).sort(), ["custom", "gemini", "groq", "nvidia", "ollama", "openrouter"]);
    for (const id of ["openai", "anthropic", "custom"]) assert.equal((await call("PUT", `/api/providers/${id}`, { key: "k" })).status, 403, id);
    const r = await call("PUT", "/api/apps/probe", { custom: { command: fake, name: "Probe" }, enabled: true }); assert.equal(r.status, 200);
    await call("POST", "/api/apps/probe/check");
    assert.ok(existsSync(seen), "the app was launched");
    assert.doesNotMatch(readFileSync(seen, "utf8"), /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  } finally { server.kill(); }
});
