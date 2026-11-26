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
const nonempty = x => typeof x === "string" && x.trim().length > 0;
const list = x => Array.isArray(x) && x.length > 0 && x.length <= 30 && x.every(nonempty);

export function criteriaFor(contract) {
  return contract.acceptanceCriteria.map((text, i) => ({ id: "AC-" + String(i + 1).padStart(2, "0"), text }));
}

export function parsePlanningArtifact(output, inputHash, contractHash, criteria) {
  let p;
  try {
    p = JSON.parse(output.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, ""));
  } catch { throw new Error("Agent did not deliver a complete structured planning artifact"); }
  if (!p || p.inputArtifactHash !== inputHash || p.contractArtifactHash !== contractHash ||
      !nonempty(p.summary) || !list(p.deliverables) || !list(p.risks) ||
      !Array.isArray(p.coverage) || p.coverage.length !== criteria.length ||
      !p.coverage.every(c => c && criteria.some(a => a.id === c.criterionId) && nonempty(c.approach)) ||
      new Set(p.coverage.map(c => c.criterionId)).size !== criteria.length) {
    throw new Error("Planning artifact lacks a matching handoff or complete acceptance-criterion coverage");
  }
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
        s.inputArtifactHash === previous.hash && s.artifactHash === artifactDigest(s.artifact) && verified(s));
      if (existing) {
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
        const validator = text => {
          try { parsePlanningArtifact(text, previous.hash, contractHash, criteria); return true; }
          catch { return false; }
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
        const artifact = parsePlanningArtifact(result.output, previous.hash, contractHash, criteria);
        stage.artifact = artifact;
        stage.artifactHash = artifactDigest(artifact);
        stage.reportedModel = result.reportedModel ?? null;
        stage.inputTokens = result.inputTokens ?? null;
        stage.outputTokens = result.outputTokens ?? null;
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
