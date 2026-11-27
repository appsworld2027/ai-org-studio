import { authorizeExecution } from "./execution-policy.mjs";

const validRequestId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
const validRepository = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

export async function dispatchTask({
  studioManifest,
  productManifest,
  allowedRepositories = studioManifest?.allowedProductRepositories || [],
  repository,
  productName = "Product",
  title,
  description,
  requestId,
  availableEngines = { free: true },
  github
} = {}) {
  if (!validRepository(repository) || !Array.isArray(allowedRepositories) || !allowedRepositories.includes(repository)) {
    throw new Error("Repository is not allowlisted for product dispatch");
  }

  const studioPolicy = authorizeExecution({
    manifest: studioManifest,
    requestedEngine: "free",
    availableEngines
  });
  if (!studioPolicy.allowed) return { status: "paused", reason: studioPolicy.reason };

  const productPolicy = authorizeExecution({
    manifest: productManifest,
    requestedEngine: "free",
    availableEngines
  });
  if (!productPolicy.allowed) return { status: "paused", reason: productPolicy.reason };

  if (
    typeof title !== "string" || !title.trim() || title.length > 200 ||
    typeof description !== "string" || !description.trim() || description.length > 20000 ||
    !validRequestId(requestId)
  ) {
    throw new Error("Invalid task input");
  }

  if (typeof github?.getRepository !== "function" || typeof github?.ensureTask !== "function") {
    throw new Error("GitHub task adapter unavailable");
  }

  const repositoryInfo = await github.getRepository({ repository });
  if (repositoryInfo?.private !== true) {
    return {
      status: "paused",
      reason: "The Parent Plus GitHub repository must be private before founder tasks can be dispatched."
    };
  }

  const body = [
    `<!-- studio-request:${requestId} -->`,
    `## Product: ${productName}`,
    "## Founder instruction",
    description.trim(),
    "",
    "## Execution constraints",
    "- Groq free-tier route only; no paid model or paid fallback.",
    "- AI Org owns planning, orchestration, implementation, independent QA and repair.",
    "- Routine engineering, tests, retries, PR creation and preview deployment proceed autonomously under repository policy.",
    "- Founder intervention is reserved for strategy changes, material product risk and release to general users.",
    "- Completion requires test evidence and an independent review; do not claim success from generated code alone."
  ].join("\n");

  const task = await github.ensureTask({
    repository,
    requestId,
    title: title.trim(),
    body,
    labels: ["ai:discovery"]
  });

  if (!Number.isInteger(task?.number) || task.number <= 0 || !/^https:\/\/github\.com\//.test(task?.url || "")) {
    throw new Error("GitHub did not confirm a valid task URL and issue number");
  }

  return {
    status: "submitted",
    repository,
    productName,
    taskNumber: task.number,
    taskUrl: task.url,
    requestId,
    assignedRole: "maya-ai-pm",
    engine: "free",
    provider: "groq",
    model: "selected by the canonical AI Org router",
    executionVerified: false
  };
}
