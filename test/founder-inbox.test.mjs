import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFounderInbox } from "../server/founder-inbox.mjs";

test("stores a bounded founder task with trusted product identity and free-only policy", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "founder-inbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inbox = createFounderInbox(dir);

  const task = inbox.submit({
    requestId: "request_12345678",
    productId: "parent-plus",
    product: "Parent Plus",
    repository: "appsworld2027/Parent-plus-",
    title: "Improve registration",
    description: "Review the registration journey and its edge cases."
  });

  assert.equal(task.productId, "parent-plus");
  assert.equal(task.product, "Parent Plus");
  assert.equal(task.repository, "appsworld2027/Parent-plus-");
  assert.equal(task.status, "queued");
  assert.equal(task.assignedRole, "maya-ai-pm");
  assert.equal(task.enginePolicy, "free-only");
  assert.equal(task.executionVerified, false);
  assert.equal(inbox.list().length, 1);
});

test("same request ID is idempotent but cannot be reused for different work or product", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "founder-inbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inbox = createFounderInbox(dir);
  const input = {
    requestId: "request_12345678",
    productId: "parent-plus",
    product: "Parent Plus",
    repository: "appsworld2027/Parent-plus-",
    title: "Improve registration",
    description: "Review registration."
  };
  const first = inbox.submit(input);
  const second = inbox.submit(input);
  assert.deepEqual(second, first);
  assert.throws(() => inbox.submit({ ...input, productId: "other-product" }), /different work/);
  assert.throws(() => inbox.submit({ ...input, title: "Different task" }), /different work/);
});

test("records GitHub dispatch evidence with an atomic update", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "founder-inbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inbox = createFounderInbox(dir);
  inbox.submit({
    requestId: "request_12345678",
    productId: "parent-plus",
    product: "Parent Plus",
    repository: "appsworld2027/Parent-plus-",
    title: "Improve registration",
    description: "Review registration."
  });

  const updated = inbox.update("request_12345678", {
    status: "submitted",
    githubIssueNumber: 123,
    githubIssueUrl: "https://github.com/appsworld2027/Parent-plus-/issues/123",
    provider: "groq",
    engine: "free",
    model: "selected by the canonical AI Org router",
    dispatchedAt: "2026-11-27T04:00:00.000Z"
  });

  assert.equal(updated.status, "submitted");
  assert.equal(updated.githubIssueNumber, 123);
  assert.equal(inbox.get("request_12345678").githubIssueUrl, updated.githubIssueUrl);
  assert.equal(inbox.list()[0].provider, "groq");
});

test("rejects invalid repository identities and unknown task updates", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "founder-inbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inbox = createFounderInbox(dir);
  assert.throws(() => inbox.submit({
    requestId: "request_12345678",
    productId: "parent-plus",
    product: "Parent Plus",
    repository: "https://github.com/appsworld2027/Parent-plus-",
    title: "Improve registration",
    description: "Review registration."
  }), /Invalid founder task/);
  assert.throws(() => inbox.update("request_12345678", { status: "submitted" }), /not found/);
});
