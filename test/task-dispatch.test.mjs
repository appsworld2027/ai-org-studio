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
const publicCodeDataPolicy = {
  scope: "public-source-code-and-synthetic-test-data-only",
  prohibitSecrets: true,
  prohibitProductionCredentials: true,
  prohibitCustomerPersonalData: true,
  prohibitChildPersonalData: true
};
const input = () => ({
  studioManifest: {
    ...policy,
    allowedProductRepositories: [PARENT_REPO],
    allowedPublicCodeRepositories: [PARENT_REPO],
    inheritProductExecutionPolicyFor: [PARENT_REPO],
    publicCodeDataPolicy
  },
  // Parent Plus's current manifest predates a product-local executionPolicy.
  productManifest: { product: { name: "Parent Plus" } },
  allowedRepositories: [PARENT_REPO],
  repository: PARENT_REPO,
  productName: "Parent Plus",
  title: "Improve registration",
  description: "Review the registration journey and identify edge cases.",
  requestId: "request_12345678",
  availableEngines: { free: true },
  github: {
    getRepository: async () => ({ fullName: PARENT_REPO, private: false }),
    ensureTask: async payload => ({
      number: 77,
      state: "open",
      url: "https://github.com/appsworld2027/Parent-plus-/issues/77",
      payload
    })
  }
});

test("repository policy allowlists use GitHub case-insensitive identity", async () => {
  const args = input();
  args.allowedRepositories = [PARENT_REPO.toLowerCase()];
  args.studioManifest.allowedPublicCodeRepositories = [PARENT_REPO.toLowerCase()];
  args.studioManifest.inheritProductExecutionPolicyFor = [PARENT_REPO.toLowerCase()];
  const result = await dispatchTask(args);
  assert.equal(result.status, "submitted");
});

test("dispatches to an explicitly approved public source-code repository", async () => {
  const result = await dispatchTask(input());
  assert.equal(result.status, "submitted");
  assert.equal(result.repository, PARENT_REPO);
  assert.equal(result.taskNumber, 77);
  assert.equal(result.assignedRole, "maya-ai-pm");
  assert.equal(result.engine, "free");
  assert.equal(result.provider, "groq");
  assert.equal(result.executionVerified, false);
});

test("never creates a task in a public repository without explicit public-code approval", async () => {
  const args = input();
  args.studioManifest.allowedPublicCodeRepositories = [];
  let created = false;
  args.github.ensureTask = async () => { created = true; throw new Error("must not create a public issue"); };
  const result = await dispatchTask(args);
  assert.equal(result.status, "paused");
  assert.match(result.reason, /public repositories require an explicit/i);
  assert.equal(created, false);
});

test("private allowlisted repositories do not need the public-code exception", async () => {
  const args = input();
  args.github.getRepository = async () => ({ fullName: PARENT_REPO, private: true });
  args.studioManifest.allowedPublicCodeRepositories = [];
  const result = await dispatchTask(args);
  assert.equal(result.status, "submitted");
});

test("public-code exception fails closed if any data restriction is missing", async () => {
  const args = input();
  args.studioManifest.publicCodeDataPolicy.prohibitChildPersonalData = false;
  const result = await dispatchTask(args);
  assert.equal(result.status, "paused");
});

test("fails closed when repository identity or visibility cannot be verified", async () => {
  const wrongIdentity = input();
  wrongIdentity.github.getRepository = async () => ({ fullName: "appsworld2027/other", private: false });
  assert.equal((await dispatchTask(wrongIdentity)).status, "paused");

  const unknownVisibility = input();
  unknownVisibility.github.getRepository = async () => ({ fullName: PARENT_REPO, private: null });
  assert.equal((await dispatchTask(unknownVisibility)).status, "paused");
});

test("product policy inheritance is explicit and never overrides an explicit disabled product policy", async () => {
  const noInheritance = input();
  noInheritance.studioManifest.inheritProductExecutionPolicyFor = [];
  assert.equal((await dispatchTask(noInheritance)).status, "paused");

  const disabledProduct = input();
  disabledProduct.productManifest.executionPolicy = {
    enabled: false,
    allowedEngines: ["free"],
    allowPaidFallback: false
  };
  assert.equal((await dispatchTask(disabledProduct)).status, "paused");
});

test("creates a task body with idempotency marker and complete free-only data policy", async () => {
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
  assert.match(payload.body, /approved free-only AI Org router/i);
  assert.match(payload.body, /no paid model, paid API, paid fallback/i);
  assert.match(payload.body, /public source code and synthetic test data/i);
  assert.match(payload.body, /child personal data/i);
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
  disabledStudio.studioManifest = {
    ...disabledStudio.studioManifest,
    executionPolicy: { ...policy.executionPolicy, enabled: false }
  };
  assert.equal((await dispatchTask(disabledStudio)).status, "paused");

  const disabledProduct = input();
  disabledProduct.productManifest.executionPolicy = {
    ...policy.executionPolicy,
    allowPaidFallback: true
  };
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
