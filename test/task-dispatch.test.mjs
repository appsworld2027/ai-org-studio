import test from "node:test";
import assert from "node:assert/strict";
import { dispatchTask } from "../server/task-dispatch.mjs";

const PARENT_REPO = "appsworld2027/Parent-plus-";
const policy = {
  executionPolicy: {
    enabled: true,
    allowedEngines: ["free"],
    allowPaidFallback: false
  }
};
const input = () => ({
  studioManifest: { ...policy, allowedProductRepositories: [PARENT_REPO] },
  productManifest: policy,
  allowedRepositories: [PARENT_REPO],
  repository: PARENT_REPO,
  productName: "Parent Plus",
  title: "Improve registration",
  description: "Review the registration journey and identify edge cases.",
  requestId: "request_12345678",
  availableEngines: { free: true },
  github: {
    ensureTask: async payload => ({
      number: 77,
      state: "open",
      url: "https://github.com/appsworld2027/Parent-plus-/issues/77",
      payload
    })
  }
});

test("dispatches a free-only task to an explicitly allowlisted product repository", async () => {
  const result = await dispatchTask(input());
  assert.equal(result.status, "submitted");
  assert.equal(result.repository, PARENT_REPO);
  assert.equal(result.taskNumber, 77);
  assert.equal(result.assignedRole, "maya-ai-pm");
  assert.equal(result.engine, "free");
  assert.equal(result.provider, "groq");
  assert.equal(result.executionVerified, false);
});

test("creates a task body with the request marker and founder operating policy", async () => {
  const args = input();
  let payload;
  args.github.ensureTask = async value => {
    payload = value;
    return { number: 77, state: "open", url: "https://github.com/appsworld2027/Parent-plus-/issues/77" };
  };
  await dispatchTask(args);
  assert.equal(payload.repository, PARENT_REPO);
  assert.deepEqual(payload.labels, ["ai:discovery"]);
  assert.ok(payload.body.startsWith("<!-- studio-request:request_12345678 -->"));
  assert.match(payload.body, /Groq free-tier route only/);
  assert.match(payload.body, /no paid model or paid fallback/);
  assert.match(payload.body, /Founder intervention is reserved/);
  assert.doesNotMatch(payload.body, /engine:free/);
});

test("rejects repositories not explicitly allowlisted", async () => {
  await assert.rejects(
    dispatchTask({ ...input(), repository: "appsworld2027/ai-org-studio" }),
    /not allowlisted/
  );
});

test("does not dispatch when either Studio or product free-only policy is disabled", async () => {
  const disabledStudio = input();
  disabledStudio.studioManifest = { ...policy, allowedProductRepositories: [PARENT_REPO], executionPolicy: { ...policy.executionPolicy, enabled: false } };
  assert.equal((await dispatchTask(disabledStudio)).status, "paused");

  const disabledProduct = input();
  disabledProduct.productManifest = { ...policy, executionPolicy: { ...policy.executionPolicy, allowPaidFallback: true } };
  assert.equal((await dispatchTask(disabledProduct)).status, "paused");
});

test("does not dispatch when the free engine is unavailable", async () => {
  const args = input();
  args.availableEngines = { free: false };
  assert.equal((await dispatchTask(args)).status, "paused");
});

test("requires a GitHub adapter and valid task fields", async () => {
  const args = input();
  delete args.github;
  await assert.rejects(dispatchTask(args), /adapter unavailable/);
  await assert.rejects(dispatchTask({ ...input(), requestId: "bad" }), /Invalid task input/);
});
