import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createFounderInbox } from "../server/founder-inbox.mjs";
import { handleFounderInbox } from "../server/founder-inbox-http.mjs";

const product = { id: "parent-plus", name: "Parent Plus", repo: "appsworld2027/Parent-plus-" };

function request(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = method === "POST" ? { "content-type": "application/json" } : {};
  return req;
}

function response() {
  return {
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = JSON.parse(body); }
  };
}

function inbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "founder-inbox-http-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createFounderInbox(dir);
}

const input = {
  requestId: "request_12345678",
  productId: "parent-plus",
  title: "Improve registration",
  description: "Review the registration journey."
};

test("GET exposes registered products and canonical dispatch state", async (t) => {
  const store = inbox(t);
  const res = response();
  await handleFounderInbox(request("GET"), res, store, {
    products: [product],
    resolveProduct: () => product,
    dispatch: async () => ({ status: "submitted" })
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.executionEnabled, true);
  assert.deepEqual(res.body.products, [product]);
});

test("GET keeps public product visible but disables confidential dispatch", async (t) => {
  const store = inbox(t);
  const res = response();
  await handleFounderInbox(request("GET"), res, store, {
    products: [product],
    dispatch: async () => ({ status: "submitted" }),
    canDispatch: async () => ({
      enabled: false,
      products: [],
      reason: "Parent Plus repository is public. Make it private before sending founder tasks."
    })
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.executionEnabled, false);
  assert.deepEqual(res.body.products, [product]);
  assert.match(res.body.executionReason, /repository is public/i);
});

test("POST creates one product-scoped GitHub task and persists the issue evidence", async (t) => {
  const store = inbox(t);
  let dispatched;
  const res = response();
  await handleFounderInbox(request("POST", input), res, store, {
    resolveProduct: id => id === product.id ? product : null,
    dispatch: async value => {
      dispatched = value;
      return {
        status: "submitted",
        taskNumber: 77,
        taskUrl: "https://github.com/appsworld2027/Parent-plus-/issues/77",
        assignedRole: "maya-ai-pm",
        engine: "free",
        provider: "groq",
        model: "selected by the canonical AI Org router"
      };
    }
  });
  assert.equal(res.statusCode, 201);
  assert.equal(dispatched.product.repo, product.repo);
  assert.equal(res.body.task.status, "submitted");
  assert.equal(res.body.task.githubIssueNumber, 77);
  assert.equal(res.body.task.githubIssueUrl, "https://github.com/appsworld2027/Parent-plus-/issues/77");
  assert.equal(res.body.task.executionVerified, false);
});

test("POST blocks public repositories before storing or dispatching a task", async (t) => {
  const store = inbox(t);
  const res = response();
  let dispatched = false;
  await handleFounderInbox(request("POST", input), res, store, {
    resolveProduct: () => product,
    dispatch: async () => { dispatched = true; throw new Error("must not run"); },
    canDispatch: async () => ({
      enabled: false,
      products: [],
      reason: "Parent Plus repository is public. Make it private before sending founder tasks."
    })
  });
  assert.equal(res.statusCode, 423);
  assert.equal(res.body.executionEnabled, false);
  assert.match(res.body.message, /repository is public/i);
  assert.equal(dispatched, false);
  assert.equal(store.list().length, 0);
});

test("POST stores a blocked state when free-only policy denies dispatch", async (t) => {
  const store = inbox(t);
  const res = response();
  await handleFounderInbox(request("POST", input), res, store, {
    resolveProduct: () => product,
    dispatch: async () => ({ status: "paused", reason: "Groq free route is unavailable" })
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.task.status, "blocked");
  assert.equal(res.body.executionEnabled, false);
  assert.match(res.body.message, /Groq free route is unavailable/);
});

test("POST preserves a retryable local task when GitHub dispatch fails", async (t) => {
  const store = inbox(t);
  const res = response();
  await handleFounderInbox(request("POST", input), res, store, {
    resolveProduct: () => product,
    dispatch: async () => { throw new Error("gh auth status failed"); }
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.task.status, "dispatch_failed");
  assert.match(res.body.task.dispatchError, /gh auth status failed/);
});

test("POST requires a registered product when dispatch is enabled", async (t) => {
  const store = inbox(t);
  const res = response();
  await handleFounderInbox(request("POST", input), res, store, {
    resolveProduct: () => null,
    dispatch: async () => { throw new Error("must not run"); }
  });
  assert.equal(res.statusCode, 400);
  assert.equal(store.list().length, 0);
});

test("local-only mode is explicit and never claims execution", async (t) => {
  const store = inbox(t);
  const res = response();
  await handleFounderInbox(request("POST", {
    requestId: "request_12345678",
    title: "Improve registration",
    description: "Review the journey."
  }), res, store);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.executionEnabled, false);
  assert.equal(res.body.task.status, "queued");
});
