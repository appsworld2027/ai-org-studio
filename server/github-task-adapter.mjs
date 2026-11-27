import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function runGh(args) {
  const { stdout } = await exec("gh", args, {
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_PAGER: "cat", GH_PROMPT_DISABLED: "1" }
  });
  return JSON.parse(stdout);
}

const validRequestId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
const validRepository = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

export function createGithubTaskAdapter({ run = runGh, allowedRepositories = [] } = {}) {
  function assertRepository(repository) {
    const allowlisted = Array.isArray(allowedRepositories) &&
      allowedRepositories.some((item) => typeof item === "string" && item.toLowerCase() === String(repository || "").toLowerCase());
    if (!validRepository(repository) || !allowlisted) {
      throw new Error("Repository is not allowlisted for Studio dispatch");
    }
  }

  async function getRepository({ repository } = {}) {
    assertRepository(repository);
    const info = await run(["api", `repos/${repository}`]);
    if (
      !info ||
      typeof info.private !== "boolean" ||
      typeof info.full_name !== "string" ||
      info.full_name.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new Error("GitHub did not confirm product repository identity and visibility");
    }
    return { fullName: info.full_name, private: info.private };
  }

  const inflight = new Map();
  // An ambiguous POST must not be repeated just because a lookup is still empty.
  // This is process-local protection; a distributed writer requires a durable shared lock.
  const uncertain = new Set();

  async function findTaskRaw({ repository, requestId } = {}) {
    assertRepository(repository);
    if (!validRequestId(requestId)) throw new Error("Invalid request ID");

    const pages = await run([
      "api", "--paginate", "--slurp",
      `repos/${repository}/issues?state=all&per_page=100`
    ]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new Error("Invalid GitHub response");
    }

    const marker = `<!-- studio-request:${requestId} -->`;
    const matches = pages.flat().filter((issue) =>
      !issue.pull_request &&
      typeof issue.body === "string" &&
      issue.body.split(/\r?\n/)[0] === marker
    );

    if (matches.length > 1) throw new Error("Duplicate GitHub tasks detected");
    if (!matches.length) return null;

    const issue = matches[0];
    if (!Number.isInteger(issue.number) || issue.number <= 0 || typeof issue.html_url !== "string") {
      throw new Error("Invalid GitHub issue response");
    }
    return issue;
  }

  function confirmedTask(issue) {
    if (!Number.isInteger(issue?.number) || issue.number <= 0 || typeof issue.html_url !== "string") {
      throw new Error("GitHub did not confirm issue creation");
    }
    return { number: issue.number, state: issue.state, url: issue.html_url };
  }

  async function findTask(input) {
    const issue = await findTaskRaw(input);
    return issue ? confirmedTask(issue) : null;
  }

  async function ensureTask({ repository, requestId, title, body, labels = [] } = {}) {
    assertRepository(repository);
    if (!validRequestId(requestId)) throw new Error("Invalid request ID");
    if (typeof title !== "string" || !title.trim() || title.length > 200 ||
        typeof body !== "string" || !body.trim() || body.length > 30000 ||
        !Array.isArray(labels) || !labels.length ||
        !labels.every((label) => /^ai:[a-z-]+$/.test(label))) {
      throw new Error("Invalid GitHub task payload");
    }

    if (body.split(/\r?\n/)[0] !== `<!-- studio-request:${requestId} -->`) {
      throw new Error("Task body must start with its exact request marker");
    }
    const key = repository.toLowerCase() + "/" + requestId;
    const fingerprint = JSON.stringify([title.trim(), body, [...labels].sort()]);
    const current = inflight.get(key);
    if (current) {
      if (current.fingerprint !== fingerprint) throw new Error("Conflicting request ID reuse");
      return current.promise;
    }
    const confirmExisting = issue => {
      if (issue.title !== title.trim() || issue.body !== body) {
        throw new Error("Conflicting request ID reuse");
      }
      if (issue.state !== "closed" && !Array.isArray(issue.labels)) throw new Error("GitHub task stage labels are unverified");
      if (issue.state !== "closed" && !issue.labels.some(label => /^ai:[a-z-]+$/.test(typeof label === "string" ? label : label?.name || ""))) {
        throw new Error("GitHub task exists but has no confirmed AI Org stage label; reconcile before retrying");
      }
      uncertain.delete(key);
      return confirmedTask(issue);
    };
    const submit = async () => {
      const existing = await findTaskRaw({ repository, requestId });
      if (existing) return confirmExisting(existing);
      if (uncertain.has(key) || uncertain.size >= 1000) {
        throw new Error("GitHub issue creation outcome uncertain; reconcile before retrying");
      }
      const args = [
        "api", "--method", "POST", `repos/${repository}/issues`,
        "-f", `title=${title.trim()}`,
        "-f", `body=${body}`
      ];
      for (const label of labels) args.push("-f", `labels[]=${label}`);
      try {
        const issue = await run(args);
        const names = Array.isArray(issue?.labels) ? issue.labels.map(label => typeof label === "string" ? label : label?.name) : [];
        if (!labels.every(label => names.includes(label))) throw new Error("GitHub did not confirm requested AI Org stage labels");
        return confirmedTask(issue);
      } catch {
        // POST can create an issue even when the response is lost. Reconcile using
        // the canonical request marker, never issue a second POST here.
        uncertain.add(key);
        const recovered = await findTaskRaw({ repository, requestId });
        if (recovered) return confirmExisting(recovered);
        throw new Error("GitHub issue creation outcome uncertain; reconcile before retrying");
      }
    };
    const promise = submit();
    inflight.set(key, { fingerprint, promise });
    try { return await promise; }
    finally { if (inflight.get(key)?.promise === promise) inflight.delete(key); }
  }

  return { getRepository, findTask, ensureTask };
}
