import { authorizeExecution } from "./execution-policy.mjs";

const validRequestId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
const validRepository = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

const PUBLIC_CODE_SCOPE = "public-source-code-and-synthetic-test-data-only";

function approvedPublicCodeRepository(studioManifest, repository) {
  const policy = studioManifest?.publicCodeDataPolicy;
  return Array.isArray(studioManifest?.allowedPublicCodeRepositories) &&
    studioManifest.allowedPublicCodeRepositories.includes(repository) &&
    policy?.scope === PUBLIC_CODE_SCOPE &&
    policy.prohibitSecrets === true &&
    policy.prohibitProductionCredentials === true &&
    policy.prohibitCustomerPersonalData === true &&
    policy.prohibitChildPersonalData === true;
}

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

  let productPolicy;
  if (productManifest && typeof productManifest === "object" && productManifest.executionPolicy) {
    productPolicy = authorizeExecution({
      manifest: productManifest,
      requestedEngine: "free",
      availableEngines
    });
  } else if (
    productManifest && typeof productManifest === "object" &&
    Array.isArray(studioManifest?.inheritProductExecutionPolicyFor) &&
    studioManifest.inheritProductExecutionPolicyFor.includes(repository)
  ) {
    // Explicitly approved inheritance for products whose manifest predates executionPolicy.
    productPolicy = studioPolicy;
  } else {
    return { status: "paused", reason: "Product execution policy is missing and inheritance is not approved" };
  }
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
  if (
    typeof repositoryInfo?.fullName !== "string" ||
    repositoryInfo.fullName.toLowerCase() !== repository.toLowerCase() ||
    typeof repositoryInfo.private !== "boolean"
  ) {
    return {
      status: "paused",
      reason: "GitHub could not verify the exact product repository identity and visibility."
    };
  }

  const publicCodeApproved = repositoryInfo.private === false &&
    approvedPublicCodeRepository(studioManifest, repository);
  if (repositoryInfo.private !== true && !publicCodeApproved) {
    return {
      status: "paused",
      reason: "Public repositories require an explicit public-source-code and synthetic-data-only approval."
    };
  }

  const body = [
    `<!-- studio-request:${requestId} -->`,
    `## Product: ${productName}`,
    "## Founder instruction",
    description.trim(),
    "",
    "## Execution constraints",
    "- Approved free-only AI Org router; every model must be on a verified zero-cost allowlist.",
    "- No paid model, paid API, paid fallback, subscription login or automatic upgrade.",
    "- Public repository work is limited to public source code and synthetic test data.",
    "- Never send secrets, production credentials, customer personal data or child personal data to hosted model providers.",
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
    provider: studioManifest.executionPolicy.provider || "selected by the canonical AI Org router",
    model: "selected by the canonical AI Org router",
    executionVerified: false
  };
}
