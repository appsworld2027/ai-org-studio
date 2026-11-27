import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { authorizeExecution } from "../server/execution-policy.mjs";

const manifest = {
  executionPolicy: {
    enabled: true,
    allowedEngines: ["free"],
    allowPaidFallback: false
  }
};

const availableEngines = {
  free: true,
  claude: true,
  codex: true
};

test("Missing policy fails closed", () => {
  assert.equal(authorizeExecution().allowed, false);
});

test("Disabled execution cannot launch agents", () => {
  assert.equal(authorizeExecution({
    manifest: {
      executionPolicy: {
        ...manifest.executionPolicy,
        enabled: false
      }
    },
    availableEngines
  }).allowed, false);
});

test("Authorized free engine can run", () => {
  const result = authorizeExecution({
    manifest,
    availableEngines
  });

  assert.equal(result.allowed, true);
  assert.equal(result.engine, "free");
  assert.equal(result.fallback, false);
});

for (const engine of ["claude", "codex", "unknown"]) {
  test(`Unauthorized engine ${engine} is blocked`, () => {
    assert.equal(authorizeExecution({
      manifest,
      requestedEngine: engine,
      availableEngines
    }).allowed, false);
  });
}

test("Free engine failure never falls back", () => {
  assert.equal(authorizeExecution({
    manifest,
    availableEngines: {
      free: false,
      claude: true,
      codex: true
    }
  }).allowed, false);
});

test("Unsafe fallback configuration is rejected", () => {
  assert.equal(authorizeExecution({
    manifest: {
      executionPolicy: {
        ...manifest.executionPolicy,
        allowPaidFallback: true
      }
    },
    availableEngines
  }).allowed, false);
});

test("Additional unauthorized engines are rejected", () => {
  assert.equal(authorizeExecution({
    manifest: {
      executionPolicy: {
        ...manifest.executionPolicy,
        allowedEngines: ["free", "codex"]
      }
    },
    availableEngines
  }).allowed, false);
});

test("the real Studio manifest enables Groq free-only execution", () => {
  const actual = JSON.parse(readFileSync(new URL("../.ai-org/manifest.json", import.meta.url), "utf8"));
  assert.equal(actual.executionPolicy.enabled, true);
  assert.deepEqual(actual.executionPolicy.allowedEngines, ["free"]);
  assert.equal(actual.executionPolicy.allowPaidFallback, false);
  assert.equal(actual.executionPolicy.provider, "groq");
  assert.equal(actual.executionPolicy.models.builder, "groq/openai/gpt-oss-120b");
  assert.equal(actual.executionPolicy.models.reviewer, "groq/qwen/qwen3.8-27b");
});
