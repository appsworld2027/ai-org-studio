const DENIED = {
  allowed: false,
  action: "pause"
};

export function authorizeExecution({
  manifest,
  requestedEngine = "free",
  availableEngines = {}
} = {}) {
  const policy = manifest?.executionPolicy;

  if (policy?.enabled !== true) {
    return {
      ...DENIED,
      reason: "Background execution is disabled"
    };
  }

  if (
    policy.allowPaidFallback !== false ||
    !Array.isArray(policy.allowedEngines) ||
    policy.allowedEngines.length !== 1 ||
    policy.allowedEngines[0] !== "free"
  ) {
    return {
      ...DENIED,
      reason: "Unsafe execution policy"
    };
  }

  if (requestedEngine !== "free") {
    return {
      ...DENIED,
      reason: "Requested engine is not authorized"
    };
  }

  if (availableEngines.free !== true) {
    return {
      ...DENIED,
      reason: "Free engine unavailable; no fallback permitted"
    };
  }

  return {
    allowed: true,
    action: "run",
    engine: "free",
    fallback: false
  };
}
