import test from "node:test";
import assert from "node:assert/strict";
import { pilotModelProfile, verifiedModels, PROBE_VERSION, ENDPOINTS, LEGACY_BUILDER, LEGACY_REVIEWER,
  splitRoute, orgRoute, fromOrgRoute, modelMatches, freeRequestFields, zeroPrice, modelFamily } from "../server/pilot-model-profile.mjs";

const builder = "groq:openai/gpt-oss-120b";
const reviewer = "groq:qwen/qwen3.8-27b";
const smaller = "groq:openai/gpt-oss-20b";
const now = Date.now();
const evidence = route => {
  const { provider, model } = splitRoute(route);
  return { route, endpoint: ENDPOINTS[provider], catalogPresent: true, httpStatus: 200,
    status: "passed", finish: "stop", reportedModel: model, sourceValid: true,
    zeroPrice: true, freeTierConfirmed: true };
};
const report = (...routes) => ({ version: PROBE_VERSION, complete: true,
  createdAt: new Date(now).toISOString(), results: routes.map(evidence) });

test("default builder and reviewer are free Groq models from different families", () => {
  const legacy = pilotModelProfile();
  assert.equal(legacy.primary, LEGACY_BUILDER);
  assert.equal(legacy.alternate, LEGACY_REVIEWER);
  assert.equal(legacy.review(LEGACY_BUILDER), LEGACY_REVIEWER);
  assert.equal(modelFamily(splitRoute(LEGACY_BUILDER).model), "gpt-oss");
  assert.equal(modelFamily(splitRoute(LEGACY_REVIEWER).model), "qwen");
});

test("auto qualification selects only Groq models with confirmed free-tier access", () => {
  const p = pilotModelProfile({ requested: "auto", report: report(builder, reviewer, smaller), now, groqFree: true });
  assert.equal(p.primary, builder);
  assert.equal(p.alternate, reviewer);
  assert.equal(p.review(builder), reviewer);
  assert.deepEqual(p.allowed, [builder, reviewer, smaller]);
  assert.deepEqual(verifiedModels(report(builder, reviewer, smaller), { now, groqFree: false }), []);
});

test("unverified, expired, incomplete and non-Groq routes cannot activate", () => {
  const r = report(builder, reviewer, smaller);
  r.results[0].reportedModel = "other";
  assert.deepEqual(verifiedModels(r, { now, groqFree: true }), [reviewer, smaller]);
  r.complete = false;
  assert.throws(() => verifiedModels(r, { now, groqFree: true }), /invalid/);
  r.complete = true;
  assert.throws(() => verifiedModels(r, { now: now + 86400001, groqFree: true }), /expired/);
  assert.throws(() => pilotModelProfile({ requested: "nvidia:nvidia/nemotron-3-ultra-550b-a55b", report: report(builder, reviewer), now, groqFree: true }), /not passed/);
});

test("provider route conversion and explicit free-model guards remain correct", () => {
  for (const route of [builder, reviewer, smaller]) assert.equal(fromOrgRoute(orgRoute(route)), route);
  assert.equal(modelMatches(splitRoute(builder).model, splitRoute(builder).model, "groq"), true);
  assert.equal(zeroPrice({ pricing: { prompt: "0", completion: "0", request: "0" } }), true);
  assert.equal(zeroPrice({ pricing: { prompt: "0", completion: "0.00001" } }), false);
  assert.equal(zeroPrice({ pricing: { prompt: "0" } }), false);
  assert.throws(() => freeRequestFields("openrouter", "vendor/model"), /explicit/);
  assert.deepEqual(freeRequestFields("openrouter", "vendor/model:free"), {
    provider: { allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0 } }
  });
});
