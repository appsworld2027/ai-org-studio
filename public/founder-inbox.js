(() => {
  const button = document.createElement("button");
  button.textContent = "Founder Inbox";
  button.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:9998;padding:12px 18px;border-radius:8px;cursor:pointer";

  const dialog = document.createElement("dialog");
  dialog.id = "founder-inbox-dialog";
  dialog.style.cssText = "width:min(720px,90vw);max-height:85vh;overflow:auto;padding:24px;border-radius:12px";

  const heading = document.createElement("h2");
  heading.textContent = "Founder Inbox";

  const notice = document.createElement("p");
  notice.textContent = "Submit a product request. Studio creates an idempotent GitHub task; the canonical AI Org worker handles planning, engineering and independent QA using free models only.";

  const form = document.createElement("form");
  const productLabel = document.createElement("label");
  productLabel.htmlFor = "founder-inbox-product";
  productLabel.textContent = "Product repository";
  const product = document.createElement("select");
  product.id = "founder-inbox-product";
  product.setAttribute("aria-label", "Product repository");
  product.required = true;
  product.style.cssText = "width:100%;margin-bottom:12px;padding:8px";
  const titleLabel = document.createElement("label");
  titleLabel.htmlFor = "founder-inbox-title";
  titleLabel.textContent = "Task title";
  const title = document.createElement("input");
  title.id = "founder-inbox-title";
  title.setAttribute("aria-label", "Task title");
  title.placeholder = "Task title";
  title.required = true;
  title.maxLength = 200;
  title.style.cssText = "width:100%;margin-bottom:12px;padding:8px";
  const descriptionLabel = document.createElement("label");
  descriptionLabel.htmlFor = "founder-inbox-description";
  descriptionLabel.textContent = "Requested outcome";
  const description = document.createElement("textarea");
  description.id = "founder-inbox-description";
  description.setAttribute("aria-label", "Requested outcome");
  description.placeholder = "Describe the outcome you want AI Org to deliver";
  description.required = true;
  description.maxLength = 20000;
  description.rows = 6;
  description.style.cssText = "width:100%;margin-bottom:12px;padding:8px";

  const submit = document.createElement("button");
  submit.textContent = "Send to AI Org";
  submit.type = "submit";
  submit.disabled = true;
  const close = document.createElement("button");
  close.textContent = "Close";
  close.type = "button";
  close.onclick = () => dialog.close();

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const tasks = document.createElement("section");
  form.append(productLabel, product, titleLabel, title, descriptionLabel, description, submit);
  dialog.append(heading, notice, form, status, tasks, close);
  document.body.append(button, dialog);

  let pendingId = null;
  let products = [];
  let executionEnabled = false;

  function link(url, label) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = label;
    return a;
  }

  function renderProducts(items, enabled) {
    executionEnabled = enabled === true;
    products = (Array.isArray(items) ? items : []).filter(item => item && item.id && item.name && item.repo);
    const selected = product.value;
    product.replaceChildren();
    for (const item of products) {
      if (!item.id || !item.name || !item.repo) continue;
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name + " — " + item.repo;
      product.append(option);
    }
    if (products.some(item => item.id === selected)) product.value = selected;
    if (!product.options.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No registered product repositories";
      product.append(option);
    }
    product.disabled = !products.length || !executionEnabled;
    submit.disabled = !products.length || !executionEnabled;
  }

  async function refresh() {
    const response = await fetch("/api/founder-inbox", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load founder inbox");
    const data = await response.json();
    renderProducts(data.products, data.executionEnabled);
    notice.textContent = data.executionEnabled
      ? "Studio is connected to the canonical AI Org dispatcher. Requests go to the selected product repository; Groq free-tier execution only, with no paid fallback."
      : (data.executionReason || "Founder Inbox is currently local-only. AI Org dispatch is not connected; no agent will run.");
    tasks.replaceChildren();

    for (const task of data.tasks || []) {
      const item = document.createElement("article");
      item.style.cssText = "padding:12px 0;border-bottom:1px solid #999";
      const name = document.createElement("h3");
      name.textContent = task.title;
      const details = document.createElement("p");
      details.textContent = [
        task.status || "queued",
        task.product || "Unassigned product",
        task.repository || "No repository",
        "Owner: " + (task.assignedRole || "Maya"),
        "Engine: " + (task.engine || task.enginePolicy || "free-only"),
        task.executionVerified ? "Execution verified" : "Delivery not yet verified"
      ].join(" · ");
      item.append(name, details);
      if (task.githubIssueUrl && task.githubIssueNumber) {
        item.append(link(task.githubIssueUrl, "Open AI Org issue #" + task.githubIssueNumber));
      }
      if (task.runtime && task.githubIssueNumber) {
        const runtime = document.createElement("p");
        runtime.textContent = "Worker: " + task.runtime.state.replaceAll("-", " ") + (task.runtime.stage ? " · " + task.runtime.stage : "") + (task.runtime.attemptVerified ? " · attempt verified (not product acceptance)" : "") + (task.runtime.checkpointUnavailable ? " · local checkpoint unavailable" : "");
        if (task.runtime.runUrl) runtime.append(" · ", link(task.runtime.runUrl, "Run evidence"));
        item.append(runtime);
      }
      if (task.dispatchError) {
        const error = document.createElement("p");
        error.textContent = "Dispatch issue: " + task.dispatchError;
        item.append(error);
      }
      tasks.append(item);
    }
  }

  button.onclick = async () => {
    dialog.showModal();
    try { await refresh(); }
    catch (error) { status.textContent = error.message; }
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (!product.value) {
      status.textContent = "Register a product repository before dispatching a task.";
      return;
    }
    submit.disabled = true;
    pendingId ||= crypto.randomUUID();
    try {
      const response = await fetch("/api/founder-inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: pendingId,
          productId: product.value,
          title: title.value,
          description: description.value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || "Submission failed");
      pendingId = null;
      title.value = "";
      description.value = "";
      const confirmation = result.message || "Submitted to AI Org.";
      // The task was created successfully. Do not encourage a second submission if the
      // receipt list cannot refresh; display success only after the issue link is rendered.
      try {
        await refresh();
        status.textContent = confirmation;
      } catch (refreshError) {
        status.textContent = confirmation + " — the inbox could not refresh. Reopen the inbox to see the existing task; do not resubmit.";
        if (result.task?.githubIssueUrl && result.task?.githubIssueNumber) {
          status.append(" ", link(result.task.githubIssueUrl, "Open AI Org issue #" + result.task.githubIssueNumber));
        }
      }
    } catch (error) {
      status.textContent = error.message + " — retrying will reuse the same request ID.";
    } finally {
      submit.disabled = !products.length || !executionEnabled;
    }
  };
})();
