import test from "node:test";
import assert from "node:assert/strict";
import {
  createGithubTaskAdapter
} from "../server/github-task-adapter.mjs";

const input = {
  repository: "appsworld2027/ai-org-studio",
  requestId: "pilot-feedback-001"
};

const issue = {
  number: 42,
  state: "open",
  body: "<!-- studio-request:pilot-feedback-001 -->\nTask",
  html_url: "https://github.com/appsworld2027/ai-org-studio/issues/42"
};

test("Existing task is recovered across pages", async () => {
  const adapter = createGithubTaskAdapter({
    run: async () => [[], [issue]]
  });

  const result = await adapter.findTask(input);
  assert.equal(result.number, 42);
});

test("Missing task returns null", async () => {
  const adapter = createGithubTaskAdapter({
    run: async () => [[]]
  });

  assert.equal(await adapter.findTask(input), null);
});

test("Pull requests are excluded", async () => {
  const adapter = createGithubTaskAdapter({
    run: async () => [[{ ...issue, pull_request: {} }]]
  });

  assert.equal(await adapter.findTask(input), null);
});

test("Duplicate tasks fail safely", async () => {
  const adapter = createGithubTaskAdapter({
    run: async () => [[issue, { ...issue, number: 43 }]]
  });

  await assert.rejects(
    adapter.findTask(input),
    /Duplicate GitHub tasks/
  );
});

test("Other repositories are blocked", async () => {
  const adapter = createGithubTaskAdapter({
    run: async () => {
      throw new Error("Must not call GitHub");
    }
  });

  await assert.rejects(
    adapter.findTask({
      ...input,
      repository: "appsworld2027/Parent-plus-"
    }),
    /outside pilot scope/
  );
});

test("Invalid request IDs are rejected", async () => {
  const adapter = createGithubTaskAdapter();

  await assert.rejects(
    adapter.findTask({ ...input, requestId: "bad" }),
    /Invalid request ID/
  );
});

test("GitHub failures are not treated as missing tasks", async () => {
  const adapter = createGithubTaskAdapter({
    run: async () => {
      throw new Error("Network failure");
    }
  });

  await assert.rejects(
    adapter.findTask(input),
    /Network failure/
  );
});

test("Live task creation remains disabled", async () => {
  const adapter = createGithubTaskAdapter();

  await assert.rejects(
    adapter.ensureTask(input),
    /creation is disabled/
  );
});
