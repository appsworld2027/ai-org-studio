import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("Studio CI uses deterministic stand-ins and never invokes Codex or subscription CLIs", () => {
  assert.match(workflow, /Browser .*stand-in engines/i);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.doesNotMatch(workflow, /@openai\/codex|@anthropic-ai\/claude-code|STUDIO_REAL_CODEX|STUDIO_REAL_CLAUDE|codex --version|claude --version/i);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY|NVIDIA_NIM_API_KEY/);
});
