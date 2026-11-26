(() => {
  const button = document.createElement("button");
  button.textContent = "Founder Inbox";
  button.style.cssText =
    "position:fixed;bottom:18px;right:18px;z-index:9998;" +
    "padding:12px 18px;border-radius:8px;cursor:pointer";

  const dialog = document.createElement("dialog");
  dialog.style.cssText =
    "width:min(720px,90vw);max-height:85vh;" +
    "overflow:auto;padding:24px;border-radius:12px";

  const heading = document.createElement("h2");
  heading.textContent = "Founder Inbox";

  const notice = document.createElement("p");
  notice.textContent =
    "Tasks are saved locally. Unattended AI Org execution is disabled; the synthetic pilot is supervised.";

  const form = document.createElement("form");
  const title = document.createElement("input");
  title.placeholder = "Task title";
  title.required = true;
  title.maxLength = 200;
  title.style.cssText = "width:100%;margin-bottom:12px";

  const description = document.createElement("textarea");
  description.placeholder =
    "Describe the outcome you want AI Org to deliver";
  description.required = true;
  description.maxLength = 20000;
  description.rows = 6;
  description.style.cssText = "width:100%;margin-bottom:12px";

  const submit = document.createElement("button");
  submit.textContent = "Queue task";
  submit.type = "submit";

  const close = document.createElement("button");
  close.textContent = "Close";
  close.type = "button";
  close.onclick = () => dialog.close();

  const status = document.createElement("p");
  status.setAttribute("role", "status");

  const tasks = document.createElement("section");

  form.append(title, description, submit);
  dialog.append(heading, notice, form, status, tasks, close);
  document.body.append(button, dialog);

  let pendingId = null;

  async function refresh() {
    const response = await fetch("/api/founder-inbox");

    if (!response.ok) {
      throw new Error("Could not load founder inbox");
    }

    const data = await response.json();
    tasks.replaceChildren();

    for (const task of data.tasks) {
      const item = document.createElement("article");
      const name = document.createElement("h3");
      name.textContent = task.title;

      const detail = document.createElement("p");
      detail.textContent = task.description;

      const state = document.createElement("small");
      state.textContent =
        `${task.status} | Planned owner: Maya | ` +
        `Execution not verified`;


      item.append(name, detail, state);

      if (task.requestId === "studio-pilot-001") {
        const panel = document.createElement("section");
        const feedback = document.createElement("textarea");
        feedback.placeholder = "What should Maya correct? (Saved before any model call)";
        feedback.maxLength = 2000;
        feedback.rows = 3;
        feedback.style.width = "100%";
        const controls = document.createElement("div");
        const evidence = document.createElement("div");
        let latest = null, busy = false, available = false, timer;

        function control(label, action) {
          const button = document.createElement("button");
          button.textContent = label;
          button.type = "button";
          button.onclick = action;
          controls.append(button);
          return button;
        }

        const save = control("Save correction", () => send("save"));
        const run = control("Run Maya", () => send("run"));
        const accept = control("Accept latest contract", () => send("accept"));
        control("Refresh status", () => loadEvidence().catch(showError));
        feedback.oninput = () => updateButtons();
        function showError(error) { status.textContent = error.message; }
        function updateButtons() {
          const running = latest?.status === "running";
          save.disabled = !available || busy || running || !feedback.value.trim();
          run.disabled = !available || busy || running || !!feedback.value.trim() || !!(latest && !["queued", "failed", "interrupted"].includes(latest.status));
          accept.disabled = !available || busy || !!feedback.value.trim() || latest?.status !== "founder-review" || !!latest?.contract?.openQuestions?.length;
          run.textContent = running ? "Maya working…" : "Run Maya";
        }
        function textElement(tag, text, parent = evidence) {
          const el = document.createElement(tag);
          el.textContent = text;
          parent.append(el);
          return el;
        }
        async function loadEvidence() {
          clearTimeout(timer);
          const response = await fetch("/api/founder-pilot");
          if (!response.ok) {
            available = false;
            updateButtons();
            state.textContent = "Supervised pilot unavailable. No agent work running.";
            return;
          }
          const { revisions } = await response.json();
          available = true;
          latest = revisions.at(-1) || null;
          state.textContent = latest
            ? "Revision " + latest.revision + " · " + latest.status
            : "Ready for supervised discovery";
          evidence.replaceChildren();
          for (const r of [...revisions].reverse()) {
            const card = document.createElement("section");
            textElement("h4", "Revision " + r.revision + " — " + r.status, card);
            if (r.feedback) textElement("p", "Founder correction: " + r.feedback, card);
            if (r.step) textElement("p", r.step, card);
            if (r.error) textElement("p", r.error, card);
            if (r.requestedModel) textElement("small",
              "Requested model: " + r.requestedModel + " · Read-tool requests: " + (r.toolCalls || 0), card);
            if (r.contract) {
              textElement("p", r.contract.summary, card);
              for (const [label, lines] of [
                ["Acceptance criteria", r.contract.acceptanceCriteria],
                ["Edge cases", r.contract.edgeCases],
                ["Open founder questions", r.contract.openQuestions]
              ]) {
                textElement("strong", label, card);
                const list = document.createElement("ul");
                for (const line of lines) textElement("li", line, list);
                if (!lines.length) textElement("li", "None", list);
                card.append(list);
              }
              for (const agent of r.agents || []) textElement("small",
                agent.agent + " · " + agent.requestedModel + " · " +
                (agent.inputTokens ?? "unknown") + " input / " +
                (agent.outputTokens ?? "unknown") + " output tokens (reported)", card);
            }
            if (r.attempts?.length) textElement("p",
              r.attempts.length + " incomplete attempt(s) preserved; not counted as delivered.", card);
            evidence.append(card);
          }
          updateButtons();
          if (latest?.status === "running" && dialog.open && panel.isConnected) {
            timer = setTimeout(() => loadEvidence().catch(showError), 2500);
          }
        }
        async function send(action) {
          busy = true;
          updateButtons();
          try {
            const response = await fetch("/api/founder-pilot", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requestId: task.requestId, action,
                revision: latest?.revision ?? null,
                ...(action === "save" ? { feedback: feedback.value } : {}) })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "Pilot action failed");
            if (action === "save") feedback.value = "";
            status.textContent = action === "save" ? "Correction saved locally; no model called."
              : action === "accept" ? "Contract accepted locally. No code, release or merge approved."
              : "Maya started. This panel updates automatically.";
            await loadEvidence();
          } catch (error) {
            showError(error);
            await loadEvidence().catch(showError);
          } finally {
            busy = false;
            updateButtons();
          }
        }
        textElement("p", "Supervised discovery only. Corrections remain local until Run Maya sends them to the configured NVIDIA model. No code changes, reviewer verdict, or delivery is implied.", panel);
        panel.append(feedback, controls, evidence);
        item.append(panel);
        save.disabled = run.disabled = accept.disabled = true;
        loadEvidence().catch(showError);
      }

      tasks.append(item, document.createElement("hr"));
    }
  }

  button.onclick = async () => {
    dialog.showModal();

    try {
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    }
  };

  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;

    pendingId ||= crypto.randomUUID();

    try {
      const response = await fetch("/api/founder-inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: pendingId,
          title: title.value,
          description: description.value
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Submission failed");
      }

      pendingId = null;
      form.reset();
      status.textContent = result.message;
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
})();
