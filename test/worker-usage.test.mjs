import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorkerUsage } from "../server/worker-usage.mjs";

test("downloads only matching recent worker reports and attributes measured usage to the product", async () => {
  const product = { id: "pilot", repo: "example/pilot" };
  const artifact = (name, id) => ({ name, workflow_run: { id }, size_in_bytes: 100 });
  let listCalls = 0;
  const load = makeWorkerUsage({
    ghJson: async (path) => {
      listCalls++;
      assert.match(path, /^repos\/example\/pilot\/actions\/artifacts/);
      return { artifacts: [artifact("agent-logs", 1), artifact("ai-org-usage-1", 2), artifact("ai-org-usage-2", 3)] };
    },
    gh: async (args) => {
      assert.equal(args[4], product.repo);
      if (args[2] === "3") throw new Error("Download unavailable");
      assert.equal(args[2], "2");
      writeFileSync(join(args.at(-1), "ai-org-usage.json"), JSON.stringify({
        version: 1, at: Date.now(),
        rows: [{ role: "Maya", model: "served", requestedModel: "alias", input: 45, output: 0 }],
      }));
    },
  });
  const result = await load(product);
  assert.deepEqual([result.available, result.reports, result.attempted], [true, 1, 2]);
  assert.deepEqual(result.entries.map((entry) => [entry.product, entry.role, entry.modelSource, entry.input, entry.output]),
    [["pilot", "Maya", "adapter", 45, 0]]);
  assert.equal(await load(product), result);
  assert.equal(listCalls, 1);
});
