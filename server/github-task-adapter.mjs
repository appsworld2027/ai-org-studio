import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PILOT_REPO = "appsworld2027/ai-org-studio";

async function runGh(args) {
  const { stdout } = await exec("gh", args, {
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GH_PAGER: "cat",
      GH_PROMPT_DISABLED: "1"
    }
  });

  return JSON.parse(stdout);
}

export function createGithubTaskAdapter({
  run = runGh
} = {}) {
  return {
    async findTask({ repository, requestId }) {
      if (repository !== PILOT_REPO) {
        throw new Error("Repository outside pilot scope");
      }

      if (
        typeof requestId !== "string" ||
        !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)
      ) {
        throw new Error("Invalid request ID");
      }

      const pages = await run([
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/issues?state=all&per_page=100`
      ]);

      if (
        !Array.isArray(pages) ||
        !pages.every(Array.isArray)
      ) {
        throw new Error("Invalid GitHub response");
      }

      const marker = `<!-- studio-request:${requestId} -->`;

      const matches = pages.flat().filter(issue =>
        !issue.pull_request &&
        typeof issue.body === "string" &&
        issue.body.split(/\r?\n/)[0] === marker
      );

      if (matches.length > 1) {
        throw new Error("Duplicate GitHub tasks detected");
      }

      if (!matches.length) return null;

      const issue = matches[0];

      if (
        !Number.isInteger(issue.number) ||
        issue.number <= 0
      ) {
        throw new Error("Invalid GitHub issue number");
      }

      return {
        number: issue.number,
        state: issue.state,
        url: issue.html_url
      };
    },

    async ensureTask() {
      throw new Error(
        "Live GitHub task creation is disabled"
      );
    }
  };
}
