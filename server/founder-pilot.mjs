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
import { createExecutionJournal, artifactDigest, failureKind } from "./execution-journal.mjs";
import { runPlanningChain } from "./coordination-pilot.mjs";

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
  const nonempty = v => typeof v === "string" && v.trim().length > 0;
  const strings = (v, min) => Array.isArray(v) && v.length >= min &&
    v.length <= 30 && v.every(nonempty);
  if (!c || !nonempty(c.summary) ||
      !strings(c.acceptanceCriteria, 2) || !strings(c.edgeCases, 1) ||
      !Array.isArray(c.openQuestions) || c.openQuestions.length > 30) {
    throw new Error("Maya's contract is missing required fields");
  }
  const openQuestions = c.openQuestions.map(q => {
    // Preserve older plain-text questions. New contracts can contain the
    // AI Org playbook's structured decision, options and recommendation.
    if (nonempty(q)) return q;
    if (!q || !nonempty(q.question) || !nonempty(q.why) ||
        !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4 ||
        !q.options.every(o => o && nonempty(o.label) && nonempty(o.consequence)) ||
        new Set(q.options.map(o => o.label)).size !== q.options.length ||
        !nonempty(q.recommended) || !q.options.some(o => o.label === q.recommended)) {
      throw new Error("Maya's contract has an invalid founder decision");
    }
    return { question: q.question, why: q.why,
      options: q.options.map(o => ({ label: o.label, consequence: o.consequence })),
      recommended: q.recommended };
  });
  return { summary: c.summary, acceptanceCriteria: c.acceptanceCriteria,
    edgeCases: c.edgeCases, openQuestions };
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

// Preload the most relevant committed implementation. The model can inspect
// further via read tools, but it should not spend its entire budget discovering
// file names or repeating reads. Missing excerpts are explicitly reported.
export function discoveryContext(source) {
  const selections = [
    ["server/founder-inbox.mjs", "", 3000],
    ["server/founder-pilot.mjs", "  function run(", 4600],
    ["public/founder-inbox.js", "        const save = control(", 1900]
  ];
  const snippets = [];
  let sourceFiles = 0;
  for (const [path, marker, limit] of selections) {
    try {
      const content = readFileSync(join(source, path), "utf8");
      const at = marker ? content.indexOf(marker) : 0;
      if (at < 0) { snippets.push(path + ": requested excerpt unavailable"); continue; }
      sourceFiles++;
      const excerpt = content.slice(at, at + limit);
      snippets.push(path + " (committed excerpt; not proof of runtime behavior):\n" + excerpt);
    } catch { snippets.push(path + ": unavailable in snapshot"); }
  }
  return { text: snippets.join("\n\n"), sourceFiles };
}

export function createFounderPilot({
  dir, inbox, orgDir, keyFile, root = ROOT, runner = runTurn
}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const active = new Set();
  const file = join(dir, PILOT_ID + ".json");
  const journal = createExecutionJournal(dir);
  const event = (type, record, fields = {}) => journal.append(type, {
    requestId: PILOT_ID, revision: record.revision, executionId: record.executionId,
    ...fields
  });

  function history(id) {
    if (id !== PILOT_ID) throw new Error("Outside pilot scope");
    if (!existsSync(file)) return [];
    const revisions = JSON.parse(readFileSync(file, "utf8"));
    let recovered = false;
    for (const r of revisions) {
      // Pre-upgrade responses remain available as evidence, not as valid contracts.
      if (!r.contract && r.agents?.length && !r.attempts) {
        r.attempts = [{ agents: r.agents, error: r.error || "Legacy output not validated" }];
        r.agents = [];
        r.status = "failed";
        r.error = "Previous agent output was not a validated contract";
      }
      if (["running", "waiting-for-contract"].includes(r.coordination?.status) && !active.has(id)) {
        r.coordination.status = "interrupted";
        r.coordination.error = "Preview restarted before coordination finished";
        for (const stage of r.coordination.stages || []) if (stage.status === "running") {
          stage.status = "interrupted";
          event("stage.interrupted", r, { executionId: stage.executionId, sourceExecutionId: stage.sourceExecutionId,
            actor: stage.role, stage: stage.stage, errorKind: "interrupted" });
        }
        event("coordination.failed", r, { actor: "studio", errorKind: "interrupted" });
        recovered = true;
      }
      if (["running", "reviewing"].includes(r.status) && !active.has(id)) {
        r.status = "interrupted";
        r.error = "Preview restarted before this run finished";
        if (r.journalVersion === 1) {
          event("run.interrupted", r, { actor: "studio", errorKind: "interrupted" });
          recovered = true;
        }
      }
    }
    if (recovered) save(revisions);
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
        engines: { free: true, codex: false, claude: false }, supervisedTrial: true });
      if (route.action !== "run" || route.engine !== "free" || route.role !== "maya-ai-pm") {
        throw new Error("Free AI Org discovery route unavailable");
      }
      role = route.role;
      model = route.free_model.replace(/^nvidia_nim\//, "");
      if (!PROVIDERS.nvidia.models.includes(model)) throw new Error("Model outside pilot allowlist");
      event("route.selected", record, { actor: role, engine: "free", requestedModel: model });
      const key = JSON.parse(readFileSync(keyFile, "utf8")).nvidia?.key;
      if (typeof key !== "string" || !key) throw new Error("NVIDIA connection unavailable");
      agent = router.agentInfo(role);
      source = snapshot(root, orgDir, role);
      const playbook = readFileSync(join(source, "playbooks/ai-pm.md"), "utf8");
      const decisions = playbook.match(/## Phase 2[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
      const quality = playbook.match(/## Quality bar[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
      const context = discoveryContext(source);
      const base = revisions.slice(0, -1).reverse().find(r => r.contract);
      const corrections = revisions.filter(r => r.revision > (base?.revision || 0) && r.feedback)
        .map(r => "Revision " + r.revision + ": " + r.feedback).join("\n");
      if (corrections.length > 12000) throw new Error("Too much pending feedback for this pilot; consolidate it first");
      event("context.prepared", record, { actor: role,
        baseRevision: base?.revision, baseArtifactHash: base?.contract ? artifactDigest(base.contract) : undefined,
        correctionCount: revisions.filter(r => r.revision > (base?.revision || 0) && r.feedback).length,
        contextChars: context.text.length, sourceFiles: context.sourceFiles });
      const messages = [{ role: "user", content: [
        "Founder objective: " + task.title + "\n" + task.description,
        base ? "Base contract: " + JSON.stringify(base.contract) : "",
        corrections ? "Founder corrections (in order):\n" + corrections : "",
        "Existing implementation evidence (read these excerpts first; do not assume the feature is complete):\n" + context.text,
        "Deliver the proposed founder feedback contract now. Inspect additional files only if a material question cannot be answered from the evidence."
      ].join("\n\n") }];
      record.requestedModel = model;
      record.step = "Maya is preparing the contract";
      save(revisions);
      let done = false, failure, reportedModel = null;
      await runner({
        messages, provider: { ...PROVIDERS.nvidia, id: "nvidia", key }, model,
        root: source, maxRounds: 3, maxTokens: 1900, allowedTools: READ_TOOLS,
        validateFinal: text => { try { parseContract(text); return true; } catch { return false; } },
        finalInstruction: "Your reading budget is complete. Do not request more tools. Return the complete valid JSON contract now from the supplied evidence and previous tool results. Include any uncertainty as an open question, rather than making unsupported claims.",
        signal: AbortSignal.timeout(240000), auto: false, approve: async () => false,
        systemPrompt: "You are " + agent.name + ", the AI Org product manager (" + role + "). " +
          "This is a supervised, read-only product discovery task. Identify the user problem, expected behavior, " +
          "scope and testable outcomes. The founder only decides material product questions; decide routine details. " +
          "No writes, GitHub actions, tests, deployments or shell commands are possible in this pilot. " +
          "The provided code excerpts are evidence of current implementation, not evidence that it runs correctly. " +
          "You may use actual list_files/read_file function calls at most during the first two rounds if truly necessary. " +
          "Never return a tool request as plain text or JSON. Return ONLY a JSON object with summary (string), " +
          "acceptanceCriteria (at least two testable Given/When/Then strings with AC IDs), " +
          "edgeCases (array of strings, aim for at least five), and openQuestions (array of decision objects, empty if none). " +
          "Each decision object must have question and why (strings), options (2–4 objects with label and consequence strings), " +
          "and recommended (the exact label of the recommended option). No markdown or extra fields. State material assumptions in the summary. " +
          "Follow these applicable AI Org playbook guidelines for founder decisions and quality, while respecting the read-only pilot:\n" +
          decisions.slice(0, 2000) + "\n" + quality.slice(0, 1200),
        observe(observation) {
          const { type, ...fields } = observation;
          if (type === "model.result" && observation.reportedModel) {
            const reported = PROVIDERS.nvidia.models.includes(observation.reportedModel)
              ? observation.reportedModel : "other-unverified";
            reportedModel = reportedModel && reportedModel !== reported ? "other-unverified" : reported;
          }
          event(type, record, { actor: role, ...fields });
          if (type === "model.request" && fields.phase === "finalize") {
            record.step = "Maya is producing the final contract";
            save(revisions);
          }
        },
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
        reportedModel, inputTokens, outputTokens, cost: null, output,
        startedAt: record.startedAt, completedAt: new Date().toISOString() }];
      record.artifactHash = artifactDigest(contract);
      record.status = "founder-review";
      record.step = "Contract ready for founder review (not a code delivery)";
      delete record.error;
      record.completedAt = new Date().toISOString();
      // The artifact must be durably persisted before the handoff is offered.
      save(revisions);
      event("artifact.saved", record, { actor: role, artifactHash: record.artifactHash });
      event("handoff.offered", record, { actor: role, fromRole: role, toRole: "founder", artifactHash: record.artifactHash });
      event("run.completed", record, { actor: role, artifactHash: record.artifactHash,
        durationMs: Date.now() - Date.parse(record.startedAt), inputTokens, outputTokens });
    } catch (error) {
      record.status = "failed";
      record.step = "Agent stopped; feedback is still saved";
      record.error = String(error.message).slice(0, 250);
      record.attempts ||= [];
      record.attempts.push({ executionId: record.executionId, agent: agent?.name, role,
        requestedModel: model, inputTokens, outputTokens, output, error: record.error });
      try {
        event("run.failed", record, { actor: role || "studio", errorKind: failureKind(error),
          durationMs: Date.now() - Date.parse(record.startedAt), inputTokens, outputTokens });
      } catch { record.journalError = "Could not append execution evidence"; }
    } finally {
      record.completedAt = new Date().toISOString();
      try { save(revisions); }
      finally {
        active.delete(PILOT_ID);
        if (source) rmSync(source, { recursive: true, force: true });
      }
    }
  }

  async function invokePlanning({ spec, contract, contractHash, criteria, previous, stage, validator, observe, route, context }) {
    let source, output = "", inputTokens = null, outputTokens = null, reportedModel = null, done = false, failure;
    try {
      const router = await import(pathToFileURL(join(orgDir, "scripts/agent-router.mjs")).href);
      const chosen = router.route({ labels: [spec.stage, "engine:free"],
        engines: { free: true, codex: false, claude: false }, supervisedTrial: true });
      if (chosen.action !== "run" || chosen.engine !== "free" || chosen.role !== spec.role) {
        throw new Error("Expected supervised free AI Org role unavailable");
      }
      const model = chosen.free_model.replace(/^nvidia_nim\//, "");
      if (!PROVIDERS.nvidia.models.includes(model)) throw new Error("Model outside pilot allowlist");
      const agent = router.agentInfo(chosen.role);
      route(model, agent.name);
      const key = JSON.parse(readFileSync(keyFile, "utf8")).nvidia?.key;
      if (typeof key !== "string" || !key) throw new Error("NVIDIA connection unavailable");
      source = snapshot(root, orgDir, chosen.role);
      const role = readFileSync(join(source, "org/agents", chosen.role + ".md"), "utf8");
      const excerpts = discoveryContext(source);
      const prompt = [
        "Exact source artifact SHA-256: " + previous.hash,
        "Exact accepted-decision draft contract SHA-256: " + contractHash,
        "Incoming artifact (read this exact JSON): " + JSON.stringify(previous.artifact),
        "Product contract (exact JSON): " + JSON.stringify(contract),
        "Stable local acceptance-criterion IDs and text: " + JSON.stringify(criteria),
        "Selected committed implementation excerpts (not proof of execution): " + excerpts.text,
        spec.brief
      ].join("\n\n");
      context({ sourceFiles: excerpts.sourceFiles, contextChars: prompt.length });
      const messages = [{ role: "user", content: prompt }];
      await runner({
        messages, provider: { ...PROVIDERS.nvidia, id: "nvidia", key }, model, root: source,
        maxRounds: 2, maxTokens: 1900, allowedTools: READ_TOOLS, auto: false, approve: async () => false,
        signal: AbortSignal.timeout(180000), validateFinal: validator,
        finalInstruction: "Return the complete role-specific planning JSON now. No further tools or code changes.",
        systemPrompt: "You are " + agent.name + " (" + chosen.role + "), the actual AI Org role. " +
          "This explicitly supervised synthetic-data test is read-only and creates a DRAFT planning artifact. " +
          "The role profile below defines your expertise; ignore any operational instructions to edit, push, run tests or ship. " +
          "No claim of implementation, release, test execution or founder contract approval is allowed. " +
          spec.brief + " Return ONLY one JSON object with inputArtifactHash (exact incoming hash), " +
          "contractArtifactHash (exact contract hash), summary (string), coverage (array of objects with criterionId " +
          "and approach, exactly one entry for every supplied local AC ID), deliverables (nonempty array of strings), " +
          "and risks (nonempty array of strings). Use the exact supplied hashes and AC IDs; be concise and actionable. " +
          "Only read source if absolutely needed. Role profile:\n" + role.slice(0, 5000),
        observe(e) {
          if (e.type === "model.result" && e.reportedModel) reportedModel =
            PROVIDERS.nvidia.models.includes(e.reportedModel) ? e.reportedModel : "other-unverified";
          observe(e);
        },
        emit(e) {
          if (e.t === "assistant_start") output = "";
          if (e.t === "delta") output += e.d;
          if (e.t === "usage") for (const u of e.models || []) {
            if (Number.isFinite(u.input)) inputTokens = (inputTokens || 0) + u.input;
            if (Number.isFinite(u.output)) outputTokens = (outputTokens || 0) + u.output;
          }
          if (e.t === "done") done = true;
          if (e.t === "error" || e.t === "stopped") failure = e.message || "Agent stopped";
        }
      });
      if (!done || failure) throw new Error(failure || "Agent ended without a final response");
      return { output: messages.at(-1)?.content || output, inputTokens, outputTokens, reportedModel };
    } finally { if (source) rmSync(source, { recursive: true, force: true }); }
  }

  function startCoordination(revisions, record) {
    if (!record.contract || record.contract.openQuestions.length ||
        !["founder-review", "contract-accepted"].includes(record.status)) {
      throw new Error("Coordination waits for a valid revised contract with no open founder decisions");
    }
    const digest = artifactDigest(record.contract);
    const evidence = journal.read(100000);
    if (evidence.invalidLines || !evidence.events.some(e => e.type === "handoff.offered" &&
        e.revision === record.revision && e.executionId === record.executionId &&
        e.artifactHash === digest && e.toRole === "founder")) {
      throw new Error("Coordination requires the matching Maya artifact handoff");
    }
    if (record.coordination?.status === "completed") return record;
    record.coordination ||= { stages: [], requestedAt: new Date().toISOString() };
    record.coordination.status = "running";
    record.coordination.contractArtifactHash = digest;
    record.coordination.approvalState = record.status === "contract-accepted" ? "contract-accepted" : "draft-founder-review";
    delete record.coordination.error;
    active.add(PILOT_ID);
    try {
      save(revisions);
      event("coordination.started", record, { actor: "studio", artifactHash: digest });
    } catch (error) {
      active.delete(PILOT_ID);
      record.coordination.status = "failed";
      record.coordination.error = "Could not persist coordination start";
      save(revisions);
      throw error;
    }
    const log = (type, stage, fields) => event(type, record, { executionId: stage.executionId, ...fields });
    void runPlanningChain({
      record, invoke: invokePlanning, persist: () => save(revisions), log,
      verified(stage) {
        const es = journal.read(100000).events.filter(e => e.executionId === stage.executionId && e.revision === record.revision);
        return es.some(e => e.type === "stage.completed" && e.artifactHash === stage.artifactHash) &&
          es.some(e => e.type === "handoff.received" && e.artifactHash === stage.inputArtifactHash);
      }
    }).then(() => {
      event(record.coordination.status === "completed" ? "coordination.completed" : "coordination.failed",
        record, { actor: "studio", artifactHash: digest });
    }).catch(() => {
      record.coordination.status = "failed";
      record.coordination.error = "Could not persist coordination evidence";
      save(revisions);
    }).finally(() => active.delete(PILOT_ID));
    return record;
  }

  function run({ requestId, action, revision, feedback = "", coordinate = false } = {}) {
    if (requestId !== PILOT_ID) throw new Error("Only the synthetic pilot is enabled");
    if (!["save", "run", "accept", "recover", "coordinate"].includes(action)) throw new Error("Choose save, run, accept, recover, or coordinate explicitly");
    if (typeof coordinate !== "boolean" || (coordinate && action !== "run")) throw new Error("Invalid supervised coordination request");
    if (active.has(requestId)) throw new Error("A supervised agent is already working");
    const task = inbox.list().find(t => t.requestId === requestId);
    if (!task) throw new Error("Founder task not found");
    const revisions = history(requestId);
    let record = revisions.at(-1);
    if ((record?.revision ?? null) !== (revision ?? null)) throw new Error("Revision changed; refresh first");
    if (action === "coordinate") {
      if (feedback !== "" || !record) throw new Error("Coordination requires an existing contract");
      return startCoordination(revisions, record);
    }
    if (action === "recover") {
      if (feedback !== "") throw new Error("Recovery does not modify feedback");
      if (record?.status === "founder-review" && record.recoveredAt) return record;
      if (record?.status !== "failed" || record.error !== "Maya's contract is missing required fields" || record.contract) {
        throw new Error("Only the saved format-rejected latest response can be recovered");
      }
      const attempt = record.attempts?.at(-1);
      if (!attempt || attempt.role !== "maya-ai-pm" || !record.executionId ||
          attempt.executionId !== record.executionId || attempt.error !== record.error ||
          typeof attempt.output !== "string") {
        throw new Error("Saved attempt does not match the failed execution");
      }
      const evidence = journal.read(100000);
      if (evidence.invalidLines) throw new Error("Execution journal is incomplete; recovery blocked");
      const events = evidence.events.filter(e => e.revision === record.revision &&
        e.requestId === requestId && e.executionId === record.executionId);
      if (!events.some(e => e.type === "run.started") ||
          !events.some(e => e.type === "route.selected" && e.actor === "maya-ai-pm") ||
          !events.some(e => e.type === "model.headers" && e.httpStatus === 200) ||
          !events.some(e => e.type === "model.result" && e.actor === "maya-ai-pm") ||
          !events.some(e => e.type === "run.failed" && e.errorKind === "invalid_artifact")) {
        throw new Error("No matching instrumented response and validation failure");
      }
      const contract = parseContract(attempt.output);
      const digest = artifactDigest(contract);
      const previous = structuredClone(record);
      const reportedModel = events.filter(e => e.type === "model.result" && e.reportedModel).at(-1)?.reportedModel ?? null;
      record.contract = contract;
      record.artifactHash = digest;
      record.recoveredAt = new Date().toISOString();
      record.agents = [{ executionId: attempt.executionId, agent: attempt.agent, role: attempt.role,
        requestedModel: attempt.requestedModel, reportedModel, inputTokens: attempt.inputTokens ?? null,
        outputTokens: attempt.outputTokens ?? null, cost: null, output: attempt.output,
        startedAt: record.startedAt, completedAt: record.completedAt }];
      record.status = "founder-review";
      record.step = "Saved Maya response revalidated locally; no new model call";
      delete record.error;
      delete record.journalError;
      try {
        save(revisions);
        event("artifact.recovered", record, { actor: "studio", artifactHash: digest });
        event("artifact.saved", record, { actor: "studio", artifactHash: digest });
        event("handoff.offered", record, { actor: "studio", fromRole: "maya-ai-pm",
          toRole: "founder", artifactHash: digest });
      } catch {
        revisions[revisions.length - 1] = previous;
        previous.journalError = "Recovery not completed: could not save execution evidence";
        save(revisions);
        throw new Error(previous.journalError);
      }
      return record;
    }
    if (action === "save") {
      if (typeof feedback !== "string" || !feedback.trim() || feedback.length > 2000) {
        throw new Error("Enter a correction of 1–2000 characters");
      }
      if (record?.status === "queued" && record.feedback === feedback.trim()) return record;
      record = { journalVersion: 1, revision: (record?.revision || 0) + 1, parentRevision: record?.revision ?? null,
        feedback: feedback.trim(), status: "queued", agents: [], createdAt: new Date().toISOString() };
      revisions.push(record);
      save(revisions);
      try { event("revision.saved", record, { actor: "founder", parentRevision: record.parentRevision }); }
      catch {
        record.journalError = "Correction saved, but execution journal is unavailable";
        save(revisions);
        throw new Error(record.journalError);
      }
      return record;
    }
    if (action === "accept") {
      if (record?.status !== "founder-review" || !record.contract || record.contract.openQuestions.length) {
        throw new Error("Only a complete latest contract without unresolved questions can be accepted");
      }
      if (record.journalVersion === 1) {
        const digest = artifactDigest(record.contract);
        const offer = journal.read(100000).events.find(e => e.type === "handoff.offered" &&
          e.revision === record.revision && e.executionId === record.executionId && e.artifactHash === digest);
        if (!offer) throw new Error("No matching recorded handoff; verify execution evidence before accepting");
      }
      record.status = "contract-accepted";
      record.acceptedAt = new Date().toISOString();
      save(revisions);
      // Legacy contracts can be accepted, but no earlier handoff is invented.
      try {
        event("handoff.acknowledged", record, { actor: "founder", fromRole: "maya-ai-pm",
          toRole: "founder", artifactHash: artifactDigest(record.contract) });
      } catch {
        record.status = "founder-review";
        delete record.acceptedAt;
        record.journalError = "Acknowledgement not saved: execution journal unavailable";
        save(revisions);
        throw new Error(record.journalError);
      }
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
    record.journalVersion = 1;
    record.status = "running";
    record.executionId = randomUUID();
    record.startedAt = new Date().toISOString();
    record.step = "Starting AI Org discovery";
    record.toolCalls = 0;
    delete record.error;
    delete record.completedAt;
    delete record.requestedModel;
    delete record.journalError;
    delete record.artifactHash;
    delete record.contract;
    record.agents = [];
    if (coordinate) record.coordination = { status: "waiting-for-contract", stages: [], requestedAt: new Date().toISOString() };
    else delete record.coordination;
    active.add(requestId);
    try {
      save(revisions);
      event("run.started", record, { actor: "studio", engine: "free" });
      if (coordinate) event("coordination.requested", record, { actor: "founder" });
    } catch (error) {
      active.delete(requestId);
      record.status = "failed";
      record.error = "Could not persist execution evidence; model not started";
      record.journalError = "Execution journal unavailable";
      save(revisions);
      throw error;
    }
    void execute(task, revisions, record).then(() => {
      if (!coordinate) return;
      if (record.status === "founder-review" && record.contract && !record.contract.openQuestions.length) {
        try { startCoordination(revisions, record); return; }
        catch (error) { record.coordination.error = String(error.message).slice(0, 250); }
      }
      record.coordination.status = "blocked";
      record.coordination.error ||= "Maya did not deliver a valid contract with all founder decisions resolved";
      save(revisions);
      event("coordination.blocked", record, { actor: "studio" });
    }).catch(() => console.error("[founder pilot] Could not persist execution outcome"));
    return record;
  }
  return { history, run, evidence: () => journal.read() };
}
