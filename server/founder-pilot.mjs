import {
  mkdirSync, readFileSync, writeFileSync, existsSync, renameSync,
  mkdtempSync, rmSync
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PROVIDERS } from "./providers.mjs";
import { runTurn } from "./agent.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PILOT_ID = "studio-pilot-001";
const READ_TOOLS = ["list_files", "read_file"];
const SOURCES = [
  "README.md", "studio-rules.md", "server/founder-inbox.mjs",
  "server/founder-inbox-http.mjs", "server/founder-pilot.mjs",
  "public/founder-inbox.js"
];

// A tool request, empty output or truncated reply is not a delivered contract.
export function parseContract(output) {
  let c;
  try {
    const raw = output.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
    c = JSON.parse(raw);
  } catch {
    throw new Error("Maya did not return a complete structured contract");
  }
  const strings = (v, min) => Array.isArray(v) && v.length >= min &&
    v.length <= 30 && v.every(x => typeof x === "string" && x.trim().length > 0);
  if (!c || typeof c.summary !== "string" || !c.summary.trim() ||
      !strings(c.acceptanceCriteria, 2) || !strings(c.edgeCases, 1) ||
      !strings(c.openQuestions, 0)) {
    throw new Error("Maya's contract is missing required fields");
  }
  return { summary: c.summary, acceptanceCriteria: c.acceptanceCriteria,
    edgeCases: c.edgeCases, openQuestions: c.openQuestions };
}

// Only explicitly selected, committed product files enter the reader's sandbox.
// No .env, local inbox, credentials, Garage, parent directories or shell access.
function snapshot(root, orgDir, role) {
  const dir = mkdtempSync(join(tmpdir(), "studio-founder-"));
  try {
    for (const path of SOURCES) {
      let content;
      try {
        content = execFileSync("git", ["show", "HEAD:" + path], {
          cwd: root, timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"]
        });
      } catch { continue; }
      const dest = join(dir, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content, { mode: 0o600 });
    }
    for (const path of ["playbooks/ai-pm.md", "org/agents/" + role + ".md"]) {
      const dest = join(dir, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(orgDir, path)), { mode: 0o600 });
    }
    return dir;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export function createFounderPilot({
  dir, inbox, orgDir, keyFile, root = ROOT, runner = runTurn
}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const active = new Set();
  const file = join(dir, PILOT_ID + ".json");

  function history(id) {
    if (id !== PILOT_ID) throw new Error("Outside pilot scope");
    if (!existsSync(file)) return [];
    const revisions = JSON.parse(readFileSync(file, "utf8"));
    for (const r of revisions) {
      // Pre-upgrade responses remain available as evidence, not as valid contracts.
      if (!r.contract && r.agents?.length && !r.attempts) {
        r.attempts = [{ agents: r.agents, error: r.error || "Legacy output not validated" }];
        r.agents = [];
        r.status = "failed";
        r.error = "Previous agent output was not a validated contract";
      }
      if (["running", "reviewing"].includes(r.status) && !active.has(id)) {
        r.status = "interrupted";
        r.error = "Preview restarted before this run finished";
      }
    }
    return revisions;
  }

  function save(revisions) {
    const temp = file + "." + randomUUID();
    writeFileSync(temp, JSON.stringify(revisions, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  }

  async function execute(task, revisions, record) {
    let source, output = "", inputTokens = null, outputTokens = null;
    let agent, model, role;
    try {
      const router = await import(pathToFileURL(join(orgDir, "scripts/agent-router.mjs")).href);
      const route = router.route({ labels: ["ai:discovery", "engine:free"],
        engines: { free: true, codex: false, claude: false } });
      if (route.action !== "run" || route.engine !== "free" || route.role !== "maya-ai-pm") {
        throw new Error("Free AI Org discovery route unavailable");
      }
      role = route.role;
      model = route.free_model.replace(/^nvidia_nim\//, "");
      if (!PROVIDERS.nvidia.models.includes(model)) throw new Error("Model outside pilot allowlist");
      const key = JSON.parse(readFileSync(keyFile, "utf8")).nvidia?.key;
      if (typeof key !== "string" || !key) throw new Error("NVIDIA connection unavailable");
      agent = router.agentInfo(role);
      source = snapshot(root, orgDir, role);
      const profile = readFileSync(join(source, "org/agents", role + ".md"), "utf8");
      const playbook = readFileSync(join(source, "playbooks/ai-pm.md"), "utf8");
      const base = revisions.slice(0, -1).reverse().find(r => r.contract);
      const corrections = revisions.filter(r => r.revision > (base?.revision || 0) && r.feedback)
        .map(r => "Revision " + r.revision + ": " + r.feedback).join("\n");
      if (corrections.length > 12000) throw new Error("Too much pending feedback for this pilot; consolidate it first");
      const messages = [{ role: "user", content: [
        "Founder objective: " + task.title + "\n" + task.description,
        base ? "Base contract: " + JSON.stringify(base.contract) : "",
        corrections ? "Founder corrections (in order):\n" + corrections : "",
        "Review the available committed product files if needed. Produce the contract now."
      ].join("\n\n") }];
      record.requestedModel = model;
      record.step = "Maya is preparing the contract";
      save(revisions);
      let done = false, failure;
      await runner({
        messages, provider: { ...PROVIDERS.nvidia, id: "nvidia", key }, model,
        root: source, maxRounds: 6, maxTokens: 1600, allowedTools: READ_TOOLS,
        signal: AbortSignal.timeout(240000), auto: false, approve: async () => false,
        systemPrompt: profile + "\n" + playbook +
          "\n\nLOCAL PILOT OVERRIDE: You are Maya doing product discovery only. " +
          "The supplied snapshot contains selected committed Studio files. Use actual list_files/read_file " +
          "function calls if needed; never emit tool request JSON as your answer. Do not write files, use GitHub, " +
          "run commands, or claim tests or implementation. Report unknowns honestly. " +
          "After reading what you need, return ONLY one JSON object with summary (string), " +
          "acceptanceCriteria (array of at least two testable strings), edgeCases (array of strings), " +
          "and openQuestions (array of unresolved material product decisions, empty if none).",
        emit(event) {
          if (event.t === "tool") {
            record.step = "Maya is reading project context";
            record.toolCalls = (record.toolCalls || 0) + 1;
            save(revisions);
          }
          if (event.t === "usage") {
            for (const u of event.models || []) {
              if (Number.isFinite(u.input)) inputTokens = (inputTokens || 0) + u.input;
              if (Number.isFinite(u.output)) outputTokens = (outputTokens || 0) + u.output;
            }
          }
          if (event.t === "assistant_start") output = "";
          if (event.t === "delta") output += event.d;
          if (event.t === "done") done = true;
          if (event.t === "error" || event.t === "stopped") failure = event.message || "Agent stopped";
        }
      });
      if (!done || failure) throw new Error(failure || "Agent ended without a final response");
      output = messages.at(-1)?.content || output;
      const contract = parseContract(output);
      record.contract = contract;
      record.agents = [{ executionId: record.executionId, agent: agent.name, role, requestedModel: model,
        reportedModel: null, inputTokens, outputTokens, cost: null, output,
        startedAt: record.startedAt, completedAt: new Date().toISOString() }];
      record.status = "founder-review";
      record.step = "Contract ready for founder review (not a code delivery)";
      delete record.error;
    } catch (error) {
      record.status = "failed";
      record.step = "Agent stopped; feedback is still saved";
      record.error = String(error.message).slice(0, 250);
      record.attempts ||= [];
      record.attempts.push({ executionId: record.executionId, agent: agent?.name, role,
        requestedModel: model, inputTokens, outputTokens, output, error: record.error });
    } finally {
      record.completedAt = new Date().toISOString();
      try { save(revisions); }
      finally {
        active.delete(PILOT_ID);
        if (source) rmSync(source, { recursive: true, force: true });
      }
    }
  }

  function run({ requestId, action, revision, feedback = "" } = {}) {
    if (requestId !== PILOT_ID) throw new Error("Only the synthetic pilot is enabled");
    if (!["save", "run", "accept"].includes(action)) throw new Error("Choose save, run, or accept explicitly");
    if (active.has(requestId)) throw new Error("Maya is already working");
    const task = inbox.list().find(t => t.requestId === requestId);
    if (!task) throw new Error("Founder task not found");
    const revisions = history(requestId);
    let record = revisions.at(-1);
    if ((record?.revision ?? null) !== (revision ?? null)) throw new Error("Revision changed; refresh first");
    if (action === "save") {
      if (typeof feedback !== "string" || !feedback.trim() || feedback.length > 2000) {
        throw new Error("Enter a correction of 1–2000 characters");
      }
      if (record?.status === "queued" && record.feedback === feedback.trim()) return record;
      record = { revision: (record?.revision || 0) + 1, parentRevision: record?.revision ?? null,
        feedback: feedback.trim(), status: "queued", agents: [], createdAt: new Date().toISOString() };
      revisions.push(record);
      save(revisions);
      return record;
    }
    if (action === "accept") {
      if (record?.status !== "founder-review" || !record.contract || record.contract.openQuestions.length) {
        throw new Error("Only a complete latest contract without unresolved questions can be accepted");
      }
      record.status = "contract-accepted";
      record.acceptedAt = new Date().toISOString();
      save(revisions);
      return record;
    }
    if (feedback !== "") throw new Error("Save corrections before running Maya");
    if (!record) {
      record = { revision: 1, parentRevision: null, feedback: "", agents: [], status: "queued",
        createdAt: new Date().toISOString() };
      revisions.push(record);
    }
    if (!["queued", "failed", "interrupted"].includes(record.status)) {
      throw new Error("Save a correction to start a new revision");
    }
    record.status = "running";
    record.executionId = randomUUID();
    record.startedAt = new Date().toISOString();
    record.step = "Starting AI Org discovery";
    record.toolCalls = 0;
    delete record.error;
    delete record.completedAt;
    delete record.requestedModel;
    active.add(requestId);
    try { save(revisions); } catch (error) { active.delete(requestId); throw error; }
    void execute(task, revisions, record).catch(() => console.error("[founder pilot] Could not persist execution outcome"));
    return record;
  }
  return { history, run };
}
