import test from "node:test";
import assert from "node:assert/strict";
import { createGithubTaskAdapter } from "../server/github-task-adapter.mjs";

const PARENT_REPO = "appsworld2027/Parent-plus-";
const requestId = "request_12345678";
const url = "https://github.com/appsworld2027/Parent-plus-/issues/44";

test("creates an allowlisted GitHub issue and reuses it on retry", async () => {
  const calls = [];
  const issues = [];
  const run = async args => {
    calls.push(args);
    if (args[0] === "api" && args[1] === `repos/${PARENT_REPO}`) return { full_name: PARENT_REPO, private: true };
    if (args[1] === "--paginate") return [[...issues]];
    if (args[1] === "--method" && args[2] === "POST") {
      const field = name => {
        const index = args.findIndex((value, i) => value === "-f" && args[i + 1]?.startsWith(name + "="));
        return index >= 0 ? args[index + 1].slice(name.length + 1) : undefined;
      };
      const body = field("body");
      const title = field("title");
      const issue = { number: 44, state: "open", html_url: url, body, title };
      issues.push(issue);
      return issue;
    }
    throw new Error("Unexpected gh invocation: " + args.join(" "));
  };
  const adapter = createGithubTaskAdapter({ run, allowedRepositories: [PARENT_REPO] });
  const payload = {
    repository: PARENT_REPO,
    requestId,
    title: "Improve registration",
    body: `<!-- studio-request:${requestId} -->\nFounder request`,
    labels: ["ai:discovery"]
  };

  const first = await adapter.ensureTask(payload);
  const second = await adapter.ensureTask(payload);

  assert.deepEqual(first, { number: 44, state: "open", url });
  assert.deepEqual(second, first);
  assert.equal(calls.filter(args => args[1] === "--method").length, 1);
  assert.ok(calls.some(args => args.includes("labels[]=ai:discovery")));
});

test("getRepository verifies canonical repository identity and privacy", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async args => {
      assert.deepEqual(args, ["api", `repos/${PARENT_REPO}`]);
      return { full_name: PARENT_REPO, private: true };
    }
  });
  assert.deepEqual(await adapter.getRepository({ repository: PARENT_REPO }), { fullName: PARENT_REPO, private: true });
});

test("getRepository rejects an unverified repository identity", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => ({ full_name: "appsworld2027/other", private: true })
  });
  await assert.rejects(adapter.getRepository({ repository: PARENT_REPO }), /did not confirm product repository identity/);
});

test("findTask returns null when no request marker exists", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[]]
  });
  assert.equal(await adapter.findTask({ repository: PARENT_REPO, requestId }), null);
});

test("rejects repositories outside the allowlist", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[]]
  });
  await assert.rejects(
    adapter.findTask({ repository: "appsworld2027/ai-org-studio", requestId }),
    /not allowlisted/
  );
});

test("rejects duplicate markers rather than silently selecting one", async () => {
  const marker = `<!-- studio-request:${requestId} -->`;
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[
      { number: 1, state: "open", html_url: url, body: marker },
      { number: 2, state: "open", html_url: url, body: marker }
    ]]
  });
  await assert.rejects(
    adapter.findTask({ repository: PARENT_REPO, requestId }),
    /Duplicate GitHub tasks detected/
  );
});

test("rejects invalid labels and request IDs", async () => {
  const adapter = createGithubTaskAdapter({
    allowedRepositories: [PARENT_REPO],
    run: async () => [[]]
  });
  await assert.rejects(
    adapter.ensureTask({ repository: PARENT_REPO, requestId: "bad", title: "x", body: "y", labels: ["ai:discovery"] }),
    /Invalid request ID/
  );
  await assert.rejects(
    adapter.ensureTask({ repository: PARENT_REPO, requestId, title: "x", body: "y", labels: ["engine:paid"] }),
    /Invalid GitHub task payload/
  );
});
