// Metadata-only, local execution evidence. Never store prompts, feedback, tool
// arguments/results, response bodies, authorization headers, or secrets here.
import { openSync, closeSync, writeFileSync, fsyncSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { PROBE_ROUTES, splitRoute } from "./pilot-model-profile.mjs";

const TYPES = new Set([
  "revision.saved", "run.started", "route.selected", "route.fallback", "context.prepared",
  "model.request", "model.headers", "model.result", "tool.request",
  "tool.result", "artifact.rejected", "artifact.recovered", "artifact.saved", "handoff.offered", "handoff.acknowledged",
  "run.completed", "run.failed", "run.interrupted", "coordination.requested", "coordination.started", "coordination.blocked", "coordination.completed", "coordination.failed", "stage.started", "stage.reused", "stage.completed", "stage.failed", "stage.interrupted", "handoff.received"
]);
const ROLES = new Set(["maya-ai-pm", "founder", "arjun-cpto", "quinn-qa", "dev-coder", "rex-reviewer", "studio"]);
const TOOLS = new Set(["read_file", "list_files", "search", "write_file", "edit_file", "run_command", "ask_user", "other"]);
const FINISH = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);
const OUTCOMES = new Set(["ok", "blocked", "error"]);
const ERRORS = new Set(["timeout", "provider_rate_limit", "provider_auth", "provider_http", "invalid_artifact", "output_limit", "interrupted", "execution_error"]);
const MODELS = new Set(["moonshotai/kimi-k3.1-pro", ...PROBE_ROUTES.flatMap(r=>{const m=splitRoute(r).model;return [m,m.replace(/:free$/,"")];})]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const uint = value => Number.isSafeInteger(value) && value >= 0;
export const artifactDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function failureKind(error) {
  const message = String(error?.message || "");
  if (["TimeoutError", "AbortError"].includes(error?.name) || /timeout|aborted/i.test(message)) return "timeout";
  if (/^429\b/.test(message)) return "provider_rate_limit";
  if (/^(401|403)\b/.test(message)) return "provider_auth";
  if (/^[45]\d\d\b/.test(message)) return "provider_http";
  if (/output limit reached/i.test(message)) return "output_limit";
  if (/Invalid artifact|structured contract|missing required fields|invalid founder decision|structured planning artifact|Planning artifact validation failed|Planning artifact lacks|final response/i.test(message)) return "invalid_artifact";
  return "execution_error";
}

export function createExecutionJournal(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "execution-events.jsonl");
  function append(type, fields = {}) {
    if (!TYPES.has(type) || !/^[a-zA-Z0-9_-]{8,100}$/.test(fields.requestId || "") ||
        !uint(fields.revision) || fields.revision < 1) throw new Error("Invalid execution event");
    const event = { version: 1, source: "studio-local-pilot", eventId: randomUUID(),
      at: new Date().toISOString(), type, requestId: fields.requestId, revision: fields.revision };
    for (const k of ["executionId", "sourceExecutionId"]) if (UUID.test(fields[k] || "")) event[k] = fields[k];
    for (const k of ["actor", "fromRole", "toRole"]) if (ROLES.has(fields[k])) event[k] = fields[k];
    for (const k of ["requestedModel", "reportedModel"]) {
      if (MODELS.has(fields[k])) event[k] = fields[k];
      else if (k === "reportedModel" && fields[k] != null) event[k] = "other-unverified";
    }
    if (/^AC-\d{2}$/.test(fields.criterionId || "")) event.criterionId = fields.criterionId;
    if (/^BUILD-\d{2}$/.test(fields.buildUnit || "")) event.buildUnit = fields.buildUnit;
    if (["ai:discovery", "ai:plan", "ai:tests", "ai:build", "ai:qa", "ai:review"].includes(fields.stage)) event.stage = fields.stage;
    if (fields.engine === "free") event.engine = "free";
    if (["nvidia","groq","openrouter"].includes(fields.providerId)) event.providerId=fields.providerId;
    if (["off", "default"].includes(fields.thinkingMode)) event.thinkingMode = fields.thinkingMode;
    if (["explore", "finalize"].includes(fields.phase)) event.phase = fields.phase;
    if (TOOLS.has(fields.tool)) event.tool = fields.tool;
    if (FINISH.has(fields.finish)) event.finish = fields.finish;
    if (OUTCOMES.has(fields.outcome)) event.outcome = fields.outcome;
    if (ERRORS.has(fields.errorKind)) event.errorKind = fields.errorKind;
    if (Array.isArray(fields.validationIssues)) {
      const allowed = new Set(["invalid_json", "input_hash_mismatch", "contract_hash_mismatch",
        "missing_summary", "invalid_deliverables", "invalid_risks", "coverage_count", "coverage_ids", "coverage_approach"]);
      event.validationIssues = [...new Set(fields.validationIssues.filter(x => allowed.has(x)))];
    }
    if (SHA.test(fields.artifactHash || "")) event.artifactHash = fields.artifactHash;
    if (SHA.test(fields.baseArtifactHash || "")) event.baseArtifactHash = fields.baseArtifactHash;
    for (const k of ["parentRevision", "baseRevision", "round", "toolIndex", "toolRequests", "httpStatus",
      "durationMs", "inputTokens", "outputTokens", "maxTokens", "responseChars", "reasoningChars", "correctionCount", "resultChars", "contextChars", "sourceFiles"]) {
      if (uint(fields[k])) event[k] = fields[k];
    }
    const fd = openSync(path, "a", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(event) + "\n", "utf8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return event;
  }

  function read(limit = 250) {
    let raw;
    try { raw = readFileSync(path, "utf8"); }
    catch (e) {
      if (e.code === "ENOENT") return { events: [], total: 0, invalidLines: 0, truncated: false };
      throw e;
    }
    const events = [];
    let invalidLines = 0;
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.version !== 1 || e.source !== "studio-local-pilot" || !TYPES.has(e.type) || !UUID.test(e.eventId || "")) throw new Error();
        events.push(e);
      } catch { invalidLines++; }
    }
    return { events: events.slice(-limit), total: events.length, invalidLines,
      truncated: events.length > limit };
  }
  return { append, read };
}
