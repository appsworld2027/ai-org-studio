export async function handleFounderInbox(req, res, inbox, options = {}) {
  const respond = (status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(data));
  };

  const dispatchEnabled = typeof options.dispatch === "function";

  if (req.method === "GET") {
    let gate = { enabled: dispatchEnabled, products: options.products || [], reason: "" };
    if (dispatchEnabled && typeof options.canDispatch === "function") {
      try { gate = await options.canDispatch(); }
      catch { gate = { enabled: false, products: [], reason: "Could not verify repository privacy; dispatch is paused." }; }
    }
    const enabled = dispatchEnabled && gate?.enabled === true;
    return respond(200, {
      tasks: options.observeTasks ? await options.observeTasks(inbox.list()) : inbox.list(),
      products: gate?.enabled ? gate.products : (options.products || []),
      executionEnabled: enabled,
      executionReason: enabled ? "" : (gate?.reason || (dispatchEnabled
        ? "Repository privacy could not be verified; dispatch is paused."
        : "Founder requests are saved locally; AI Org dispatch is not connected.")),
      message: enabled
        ? "Founder requests are dispatched to the canonical AI Org worker."
        : (gate?.reason || "Founder requests are saved locally; AI Org dispatch is not connected.")
    });
  }

  if (req.method !== "POST") return respond(405, { error: "Method not allowed" });
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return respond(415, { error: "JSON required" });
  }

  let task = null;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 100000) return respond(413, { error: "Request too large" });
      chunks.push(chunk);
    }

    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    if (!dispatchEnabled) {
      task = inbox.submit(input);
      return respond(201, {
        task,
        executionEnabled: false,
        message: "Saved locally. AI Org dispatch is not connected."
      });
    }

    if (typeof options.resolveProduct !== "function") {
      return respond(503, { error: "Product resolver is unavailable" });
    }

    const product = await options.resolveProduct(input.productId);
    if (!product || !product.id || !product.repo || !product.name) {
      return respond(400, { error: "Select a registered product before sending this task to AI Org." });
    }

    if (typeof options.canDispatch === "function") {
      let gate;
      try { gate = await options.canDispatch(); }
      catch { gate = { enabled: false, reason: "Could not verify repository privacy; dispatch is paused." }; }
      if (gate?.enabled !== true || !(gate.products || []).some((item) => item.id === product.id)) {
        return respond(423, {
          error: "Founder task dispatch is paused.",
          message: gate?.reason || "The product repository must be private before dispatch.",
          executionEnabled: false
        });
      }
    }

    task = inbox.submit({
      ...input,
      productId: product.id,
      product: product.name,
      repository: product.repo
    });

    const result = await options.dispatch({ task, product });

    if (result?.status === "paused") {
      const blocked = inbox.update(task.requestId, {
        status: "blocked",
        dispatchError: String(result.reason || "Free-only execution policy blocked dispatch").slice(0, 500)
      });
      return respond(200, {
        task: blocked,
        executionEnabled: false,
        message: `Saved, but not dispatched: ${blocked.dispatchError}`
      });
    }

    if (result?.status !== "submitted" || !Number.isInteger(result.taskNumber) || !result.taskUrl) {
      throw new Error("AI Org did not confirm GitHub task creation");
    }

    const submitted = inbox.update(task.requestId, {
      status: "submitted",
      githubIssueNumber: result.taskNumber,
      githubIssueUrl: result.taskUrl,
      assignedRole: result.assignedRole || "maya-ai-pm",
      engine: result.engine || "free",
      provider: result.provider || "groq",
      model: result.model || "selected by AI Org router",
      executionVerified: false,
      dispatchedAt: new Date().toISOString(),
      dispatchError: ""
    });

    return respond(201, {
      task: submitted,
      executionEnabled: true,
      message: `Submitted to the canonical AI Org worker: ${product.name} issue #${result.taskNumber}.`
    });
  } catch (error) {
    const known = [
      "Invalid founder task",
      "Request ID already used for different work",
      "Founder task not found"
    ];
    if (task?.requestId) {
      try {
        inbox.update(task.requestId, {
          status: "dispatch_failed",
          dispatchError: String(error.message || "GitHub dispatch failed").slice(0, 500)
        });
      } catch { /* preserve the original failure */ }
    }
    const status = known.includes(error.message) ? 400 : 502;
    return respond(status, {
      error: known.includes(error.message) ? error.message : "Unable to dispatch founder task to GitHub.",
      message: String(error.message || "Unknown dispatch error").slice(0, 300),
      task: task?.requestId ? inbox.get(task.requestId) : null
    });
  }
}
