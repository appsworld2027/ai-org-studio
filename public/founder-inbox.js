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
    "Tasks are saved locally. Background execution is disabled.";

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
        feedback.placeholder = "What should Maya correct?";
        feedback.maxLength = 2000;
        feedback.rows = 3;
        feedback.style.width = "100%";

        const run = document.createElement("button");
        run.textContent = "Run discovery / request revision";
        run.type = "button";

        const evidence = document.createElement("div");

        async function loadEvidence() {
          const response = await fetch("/api/founder-pilot");
          if (!response.ok) return;

          const { revisions } = await response.json();
          evidence.replaceChildren();

          for (const revision of revisions) {
            const h = document.createElement("h4");
            h.textContent =
              `Revision ${revision.revision}: ${revision.status}`;
            evidence.append(h);

            for (const agent of revision.agents) {
              const heading = document.createElement("strong");
              heading.textContent =
                `${agent.agent} — ${agent.requestedModel}`;

              const output = document.createElement("pre");
              output.style.whiteSpace = "pre-wrap";
              output.textContent = agent.output;

              evidence.append(heading, output);
            }
          }
        }

        run.onclick = async () => {
          run.disabled = true;
          run.textContent = "Agents working…";

          try {
            const response = await fetch("/api/founder-pilot", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requestId: task.requestId,
                feedback: feedback.value
              })
            });

            const result = await response.json();

            if (!response.ok) {
              throw new Error(result.error || "Pilot failed");
            }

            feedback.value = "";
            await loadEvidence();
          } catch (error) {
            status.textContent = error.message;
            await loadEvidence();
          } finally {
            run.disabled = false;
            run.textContent = "Run discovery / request revision";
          }
        };

        panel.append(feedback, run, evidence);
        item.append(panel);
        loadEvidence().catch(() => {});
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
