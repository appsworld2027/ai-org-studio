import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStore } from "../server/store.mjs";
import { makeLedger, summarize, makeEntry } from "../server/usage.mjs";
import { translate } from "../server/engines/claude.mjs";

test("unreported numbers stay null, never 0", () => {
  const e = makeEntry({ engine: "claude", model: "opus", input: undefined, output: "x", cost: -1 });
  assert.equal(e.input, null); assert.equal(e.output, null); assert.equal(e.cost, null);
});
test("summary groups by engine+model+role and keeps unknown separate from zero", () => {
  const s = summarize([makeEntry({ engine: "claude", model: "opus", input: 100, output: 50, cost: 0.5 }), makeEntry({ engine: "claude", model: "opus", input: 10, output: 5 }),
    makeEntry({ engine: "free:nvidia", model: "nemotron" })]);
  const opus = s.rows.find((r) => r.model === "opus");
  assert.deepEqual([opus.turns, opus.input, opus.output, opus.cost], [2, 110, 55, 0.5]);
  const free = s.rows.find((r) => r.model === "nemotron");
  assert.equal(free.input, null); assert.equal(free.unknownTurns, 1);
  assert.equal(s.total.turns, 3);
});
test("ledger persists and filters by product and window", () => {
  const store = makeStore(mkdtempSync(join(tmpdir(), "usage-")));
  const l = makeLedger(store); l.record({ product: "a", engine: "codex", model: "gpt", input: 1, output: 2 }); l.record({ product: "b", engine: "codex", model: "gpt", input: 3, output: 4 });
  assert.equal(l.entries("a").length, 1); assert.equal(l.entries().length, 2);
  assert.equal(summarize(l.entries("a"), { since: Date.now() + 1000 }).total.turns, 0);
});
test("Claude result message yields per-model usage", () => {
  const out = translate({ type: "result", subtype: "success", total_cost_usd: 0.12, duration_ms: 900, modelUsage: { "claude-opus": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1, costUSD: 0.1 } } }, { tools: {} });
  const u = out.find((e) => e.t === "usage");
  assert.deepEqual(u.models, [{ model: "claude-opus", input: 10, output: 5, cache: 3, cost: 0.1 }]);
});
