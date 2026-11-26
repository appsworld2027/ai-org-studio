import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionJournal, artifactDigest } from "../server/execution-journal.mjs";
import { workflowEvidenceFrom } from "../server/status.mjs";

test("journal persists metadata only and reports malformed lines", t => {
  const dir = mkdtempSync(join(tmpdir(), "studio-journal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = createExecutionJournal(dir);
  assert.equal(log.read().total, 0);
  log.append("model.request", { requestId: "studio-pilot-001", revision: 1,
    actor: "maya-ai-pm", round: 1, requestedModel: "nvidia/nemotron-3-ultra-550b-a55b",
    args: "PRIVATE_TOOL_ARGS", prompt: "PRIVATE_PROMPT", key: "PRIVATE_KEY" });
  log.append("model.result", { requestId: "studio-pilot-001", revision: 1,
    inputTokens: 0, outputTokens: 5, responseChars: 12, reasoningChars: 99, maxTokens: 6000, thinkingMode: "off", reasoning: "PRIVATE_REASONING", reportedModel: "PRIVATE_PROVIDER_STRING", outcome: "ok" });
  const path = join(dir, "execution-events.jsonl");
  const text = readFileSync(path, "utf8");
  assert.doesNotMatch(text, /PRIVATE_/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const reopened = createExecutionJournal(dir).read();
  assert.equal(reopened.total, 2);
  assert.equal(reopened.events[1].inputTokens, 0);
  assert.equal(reopened.events[1].reasoningChars, 99);
  assert.equal(reopened.events[1].responseChars, 12);
  assert.equal(reopened.events[1].thinkingMode, "off");
  assert.equal(reopened.events[1].reportedModel, "other-unverified");
  assert.equal(createExecutionJournal(dir).read(1).truncated, true);
  appendFileSync(path, "{truncated\n");
  assert.equal(createExecutionJournal(dir).read().invalidLines, 1);
  assert.equal(artifactDigest({ summary: "A" }), artifactDigest({ summary: "A" }));
  assert.notEqual(artifactDigest({ summary: "A" }), artifactDigest({ summary: "B" }));
});

test("GitHub evidence distinguishes workflow setup, engine execution and handover check from receipt", () => {
  const runs = [
    { id: 1, name: "AI agents", status: "in_progress", html_url: "https://github.com/example/run/1" },
    { id: 2, name: "AI agents", status: "in_progress", html_url: "https://github.com/example/run/2" },
    { id: 3, name: "AI agents", status: "completed", conclusion: "success" },
    { id: 4, name: "AI agents", status: "queued" }
  ];
  const evidence = workflowEvidenceFrom(runs, {
    1: [{ name: "agent", steps: [{ name: "Onboarding pack", status: "in_progress" }] }],
    2: [{ name: "agent", steps: [{ name: "Run agent with the free engine", status: "in_progress" }] }],
    3: [{ name: "agent", steps: [{ name: "Handover check", status: "completed", conclusion: "success" },
      { name: "Chain to the next agent if the stage changed", status: "completed", conclusion: "success" }] }]
  });
  assert.equal(evidence[0].engineActive, false);
  assert.equal(evidence[1].engineActive, true);
  assert.equal(evidence[2].handoverCheck, "success");
  assert.equal(evidence[2].downstreamReceiptVerified, false);
  assert.equal(evidence[3].jobsAvailable, false);
});
