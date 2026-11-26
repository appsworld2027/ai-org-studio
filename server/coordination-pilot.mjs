// Supervised synthetic-data coordination. Real role routing and model calls,
// but strictly draft artifacts: no repo writes, test execution or release.
import { randomUUID } from "node:crypto";
import { artifactDigest, failureKind } from "./execution-journal.mjs";

const STAGES = [
  { stage: "ai:plan", role: "arjun-cpto", label: "Architecture and implementation plan",
    brief: "Make a buildable engineering plan: data/state/API and UI boundaries, sequencing, ownership, security, risks and how each acceptance criterion will be implemented. Deliverables are concrete implementation tasks; no claim of code changes." },
  { stage: "ai:tests", role: "quinn-qa", label: "Acceptance test design",
    brief: "Independently design tests for the exact product contract and engineering plan. Each coverage approach must specify a scenario and expected result. Deliverables are test cases and negative cases, not test results. Identify gaps and do not claim tests ran." }
];
const nonempty = x => typeof x === "string" && x.trim().length > 0 && !/^REPLACE\b/i.test(x.trim());
const list = x => Array.isArray(x) && x.length > 0 && x.length <= 30 && x.every(nonempty);

export function criteriaFor(contract) {
  return contract.acceptanceCriteria.map((text, i) => ({ id: "AC-" + String(i + 1).padStart(2, "0"), text }));
}

// Diagnostics contain only fixed labels, never model text, in the event journal.
export function parsePlanningArtifact(output, inputHash, contractHash, criteria) {
  const reject = issues => {
    const error = new Error("Planning artifact validation failed: " + issues.join(", "));
    error.validationIssues = issues;
    throw error;
  };
  let p;
  try {
    p = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, ""));
  } catch { reject(["invalid_json"]); }
  const issues = [];
  if (p?.inputArtifactHash !== inputHash) issues.push("input_hash_mismatch");
  if (p?.contractArtifactHash !== contractHash) issues.push("contract_hash_mismatch");
  if (!nonempty(p?.summary)) issues.push("missing_summary");
  if (!list(p?.deliverables)) issues.push("invalid_deliverables");
  if (!list(p?.risks)) issues.push("invalid_risks");
  if (!Array.isArray(p?.coverage) || p.coverage.length !== criteria.length) issues.push("coverage_count");
  if (Array.isArray(p?.coverage)) {
    if (!p.coverage.every(c => c && criteria.some(a => a.id === c.criterionId)) ||
        new Set(p.coverage.map(c => c?.criterionId)).size !== criteria.length) issues.push("coverage_ids");
    if (!p.coverage.every(c => nonempty(c?.approach))) issues.push("coverage_approach");
  }
  if (issues.length) reject(issues);
  return { inputArtifactHash: p.inputArtifactHash, contractArtifactHash: p.contractArtifactHash,
    summary: p.summary, coverage: p.coverage.map(c => ({ criterionId: c.criterionId, approach: c.approach })),
    deliverables: p.deliverables, risks: p.risks };
}

export async function runPlanningChain({ record, persist, log, invoke, verified }) {
  const c = record.coordination;
  const contract = record.contract;
  const contractHash = artifactDigest(contract);
  const criteria = criteriaFor(contract);
  let previous = { artifact: contract, hash: contractHash, role: "maya-ai-pm", executionId: record.executionId };
  try {
    for (const spec of STAGES) {
      const existing = c.stages.find(s => s.stage === spec.stage && s.status === "completed" &&
        s.sourceExecutionId === previous.executionId && s.inputArtifactHash === previous.hash &&
        s.artifact && s.artifactHash === artifactDigest(s.artifact) && verified(s));
      if (existing) {
        log("stage.reused", existing, { actor: "studio", stage: existing.stage,
          sourceExecutionId: existing.sourceExecutionId, artifactHash: existing.artifactHash });
        previous = { artifact: existing.artifact, hash: existing.artifactHash, role: existing.role, executionId: existing.executionId };
        continue;
      }
      const stage = { stage: spec.stage, role: spec.role, label: spec.label, status: "running",
        executionId: randomUUID(), sourceExecutionId: previous.executionId, inputArtifactHash: previous.hash,
        contractArtifactHash: contractHash, startedAt: new Date().toISOString() };
      c.stages.push(stage);
      c.currentRole = spec.role;
      persist();
      const emit = (type, fields = {}) => log(type, stage, { actor: spec.role,
        stage: spec.stage, sourceExecutionId: previous.executionId, ...fields });
      let providerOk = false, resultObserved = false;
      try {
        emit("stage.started");
        emit("handoff.offered", { actor: "studio", fromRole: previous.role, toRole: spec.role, artifactHash: previous.hash });
        const recordRejected = (text, error) => {
          const raw = typeof text === "string" ? text : "";
          stage.validationIssues = error.validationIssues || ["invalid_json"];
          (stage.rejectedAttempts ||= []).push({
            at: new Date().toISOString(), validationIssues: stage.validationIssues,
            output: raw.slice(0, 20000), outputHash: artifactDigest(raw),
            truncated: raw.length > 20000
          });
          persist();
          emit("artifact.rejected", { outcome: "error", errorKind: "invalid_artifact",
            validationIssues: stage.validationIssues, resultChars: raw.length });
        };
        const validator = text => {
          try { parsePlanningArtifact(text, previous.hash, contractHash, criteria); return true; }
          catch (error) { recordRejected(text, error); return false; }
        };
        const result = await invoke({ spec, contract, contractHash, criteria, previous, stage, validator,
          observe(e) {
            const { type, ...fields } = e;
            if (type === "model.headers" && fields.httpStatus === 200) providerOk = true;
            if (type === "model.result") resultObserved = true;
            emit(type, fields);
          },
          route(model, actor) {
            stage.requestedModel = model;
            stage.agent = actor;
            emit("route.selected", { engine: "free", requestedModel: model });
            persist();
          },
          context(fields) { emit("context.prepared", { baseArtifactHash: previous.hash, ...fields }); }
        });
        if (!providerOk || !resultObserved) throw new Error("No observed provider response for this agent");
        stage.reportedModel = result.reportedModel ?? null;
        stage.inputTokens = result.inputTokens ?? null;
        stage.outputTokens = result.outputTokens ?? null;
        let artifact;
        try { artifact = parsePlanningArtifact(result.output, previous.hash, contractHash, criteria); }
        catch (error) { recordRejected(result.output, error); throw error; }
        delete stage.validationIssues;
        stage.artifact = artifact;
        stage.artifactHash = artifactDigest(artifact);
        stage.completedAt = new Date().toISOString();
        stage.status = "completed";
        persist();
        // Exact artifact was attached to the request; provider responded and the
        // returned role-specific artifact acknowledged the same digest and all ACs.
        emit("handoff.received", { fromRole: previous.role, toRole: spec.role, artifactHash: previous.hash });
        emit("artifact.saved", { artifactHash: stage.artifactHash });
        emit("stage.completed", { artifactHash: stage.artifactHash,
          durationMs: Date.now() - Date.parse(stage.startedAt), inputTokens: stage.inputTokens, outputTokens: stage.outputTokens });
        previous = { artifact, hash: stage.artifactHash, role: spec.role, executionId: stage.executionId };
      } catch (error) {
        stage.status = "failed";
        stage.completedAt = new Date().toISOString();
        stage.error = String(error.message).slice(0, 250);
        try { emit("stage.failed", { errorKind: failureKind(error), durationMs: Date.now() - Date.parse(stage.startedAt) }); }
        catch { stage.journalError = "Could not append stage evidence"; }
        persist();
        throw error;
      }
    }
    c.status = "completed";
    c.currentRole = null;
    c.completedAt = new Date().toISOString();
  } catch (error) {
    c.status = "failed";
    c.error = String(error.message).slice(0, 250);
    c.completedAt = new Date().toISOString();
  } finally { persist(); }
}
