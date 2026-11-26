import { authorizeExecution } from "./execution-policy.mjs";

export async function dispatchTask({
  manifest,
  repository,
  title,
  description,
  requestId,
  availableEngines = {},
  github
} = {}) {
  const policy = authorizeExecution({
    manifest,
    requestedEngine: "free",
    availableEngines
  });

  if (!policy.allowed) {
    return {
      status: "paused",
      reason: policy.reason
    };
  }

  if (repository !== "appsworld2027/ai-org-studio") {
    throw new Error("Repository is outside the pilot scope");
  }

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200 ||
    typeof description !== "string" ||
    !description.trim() ||
    description.length > 20000 ||
    typeof requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)
  ) {
    throw new Error("Invalid task input");
  }

  if (typeof github?.ensureTask !== "function") {
    throw new Error("GitHub task adapter unavailable");
  }

  const task = await github.ensureTask({
    repository,
    requestId,
    title: title.trim(),
    body: [
      `<!-- studio-request:${requestId} -->`,
      "## Founder instruction",
      description.trim(),
      "",
      "## Execution constraints",
      "- Free engine only.",
      "- No paid fallback.",
      "- No automatic merge or production deployment.",
      "- Independent QA and evidence required."
    ].join("\n"),
    labels: ["ai:discovery", "engine:free"]
  });

  if (
    !Number.isInteger(task?.number) ||
    task.number <= 0
  ) {
    throw new Error("GitHub did not confirm a task");
  }

  return {
    status: "submitted",
    repository,
    taskNumber: task.number,
    requestId,
    assignedRole: "maya-ai-pm",
    engine: "free",
    executionVerified: false
  };
}
