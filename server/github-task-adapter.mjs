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
    if (!validRepository(repository) || !Array.isArray(allowedRepositories) || !allowedRepositories.includes(repository)) {
      throw new Error("Repository is not allowlisted for Studio dispatch");
    }
  }

  async function findTask({ repository, requestId } = {}) {
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
    return { number: issue.number, state: issue.state, url: issue.html_url };
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

    const existing = await findTask({ repository, requestId });
    if (existing) return existing;

    const args = [
      "api", "--method", "POST", `repos/${repository}/issues`,
      "-f", `title=${title.trim()}`,
      "-f", `body=${body}`
    ];
    for (const label of labels) args.push("-f", `labels[]=${label}`);

    const issue = await run(args);
    if (!Number.isInteger(issue?.number) || issue.number <= 0 || typeof issue.html_url !== "string") {
      throw new Error("GitHub did not confirm issue creation");
    }
    return { number: issue.number, state: issue.state, url: issue.html_url };
  }

  return { findTask, ensureTask };
}
