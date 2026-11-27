import test from "node:test";
import assert from "node:assert/strict";
import { sortModels } from "../server/providers.mjs";
import { providerAllowed, modelAllowed } from "../server/billing.mjs";

test("custom model catalog is available only for an approved loopback test fixture", () => {
  const ids = ["test/model-a", "test/model-b", "test/model-a"];
  const local = "http://127.0.0.1:8497/v1";
  const remote = "https://example.com/v1";
  const env = { STUDIO_TEST_MODE: "1" };
  const listed = (e, base) => sortModels("custom", ids, {
    allowLocalFixture: providerAllowed("custom", e, base)
  }).filter((id) => modelAllowed("custom", id, e, base));
  assert.deepEqual(sortModels("custom", ids), []);
  assert.deepEqual(listed({}, local), []);
  assert.deepEqual(listed(env, remote), []);
  assert.deepEqual(listed(env, local), ["test/model-a", "test/model-b"]);
});
