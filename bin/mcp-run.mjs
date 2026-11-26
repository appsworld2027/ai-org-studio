#!/usr/bin/env node
// Starts one connected app's MCP server with its key. Claude Code / Codex / the Studio run THIS (not the server
// directly), so the key never appears in their config, their environment or the AI's shell — only in the app's
// own server process. Usage: node mcp-run.mjs <app-id> [studio-folder]
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeConnectors } from "../server/connectors.mjs";
import { planEnv } from "../server/billing.mjs";

const id = process.argv[2] || "";
const dir = process.argv[3] || process.env.STUDIO_HOME || join(homedir(), ".ai-org-studio");
const c = makeConnectors({ dir, root: join(fileURLToPath(import.meta.url), "../..") });
let l; try { l = c.launch(id); } catch (e) { process.stderr.write(`AI Org Studio: ${e.message}\n`); process.exit(2); }
// Drop the Studio's own variables; keep PATH/HOME etc. so npx works. Add only this app's keys.
const env = { ...planEnv(), ...l.env }; for (const k of Object.keys(env)) if (k.startsWith("STUDIO_TOKEN")) delete env[k];
const p = spawn(l.command, l.args, { stdio: "inherit", env });
p.on("exit", (code, sig) => process.exit(sig ? 1 : code ?? 0));
p.on("error", (e) => { process.stderr.write(`AI Org Studio: could not start ${id}: ${e.message}\n`); process.exit(2); });
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => p.kill(s));
