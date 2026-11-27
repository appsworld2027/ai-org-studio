import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("legacy Studio discovery requires private repository and explicit unattended opt-in at both jobs", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ai-agents.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("authorize:\n    if: github.event.repository.private == true && vars.UNATTENDED_AGENTS == 'on'"));
  assert.ok(workflow.includes("if: github.event.repository.private == true && vars.UNATTENDED_AGENTS == 'on' && needs.authorize.outputs.allowed == 'true'"));
});
