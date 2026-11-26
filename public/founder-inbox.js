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
        const activity = document.createElement("section");
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
        const recover = control("Recover saved contract (no model call)", () => send("recover"));
        control("Refresh status", () => loadEvidence().catch(showError));
        feedback.oninput = () => updateButtons();
        function showError(error) { status.textContent = error.message; }
        function updateButtons() {
          const running = latest?.status === "running";
          const recoverable = latest?.status === "failed" &&
            latest.error === "Maya's contract is missing required fields" &&
            !!latest.attempts?.at(-1)?.output;
          recover.hidden = !recoverable;
          recover.disabled = !available || busy || !recoverable;
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
          const { revisions, executionEvidence } = await response.json();
          available = true;
          latest = revisions.at(-1) || null;
          state.textContent = latest
            ? "Revision " + latest.revision + " · " + latest.status
            : "Ready for supervised discovery";
          renderActivity(executionEvidence);
          evidence.replaceChildren();
          for (const r of [...revisions].reverse()) {
            const card = document.createElement("section");
            textElement("h4", "Revision " + r.revision + " — " + r.status, card);
            if (r.feedback) textElement("p", "Founder correction: " + r.feedback, card);
            if (r.step) textElement("p", r.step, card);
            if (r.error) textElement("p", r.error, card);
            if (r.journalError) textElement("p", r.journalError, card);
            if (!r.journalVersion) textElement("small", "This run predates structured logging.", card);
            if (r.requestedModel) textElement("small",
              "Requested model: " + r.requestedModel + " · Read-tool requests: " + (r.toolCalls || 0), card);
            if (r.recoveredAt) textElement("p", "Saved response recovered by local validation; no new model call.", card);
            if (r.contract) {
              textElement("p", r.contract.summary, card);
              for (const [label, lines] of [
                ["Acceptance criteria", r.contract.acceptanceCriteria],
                ["Edge cases", r.contract.edgeCases]
              ]) {
                textElement("strong", label, card);
                const list = document.createElement("ul");
                for (const line of lines) textElement("li", line, list);
                if (!lines.length) textElement("li", "None", list);
                card.append(list);
              }
              renderQuestions(r, card);
              for (const agent of r.agents || []) textElement("small",
                agent.agent + " · requested " + agent.requestedModel + " · reported " + (agent.reportedModel || "unknown") + " · " +
                (agent.inputTokens ?? "unknown") + " input / " +
                (agent.outputTokens ?? "unknown") + " output tokens (reported)", card);
            }
            if (r.attempts?.length) textElement("p",
              r.attempts.length + " original failed attempt(s) preserved; recovery is recorded separately.", card);
            evidence.append(card);
          }
          updateButtons();
          if (latest?.status === "running" && dialog.open && panel.isConnected) {
            timer = setTimeout(() => loadEvidence().catch(showError), 2500);
          }
        }
        function renderQuestions(r, card) {
          const questions = r.contract.openQuestions || [];
          textElement("strong", "Open founder decisions", card);
          if (!questions.length) { textElement("p", "None", card); return; }
          const interactive = r.revision === latest?.revision && r.status === "founder-review";
          const choices = new Map();
          let previousApplied = "";
          const structured = questions.filter(q => typeof q !== "string").length;
          for (const [i, q] of questions.entries()) {
            const group = document.createElement("fieldset");
            group.style.cssText = "margin:8px 0;padding:10px;border:1px solid currentColor;border-radius:6px";
            textElement("legend", (i + 1) + ". " + (typeof q === "string" ? q : q.question), group);
            if (typeof q === "string") {
              textElement("p", "Respond in the correction box.", group);
            } else {
              textElement("p", q.why, group);
              for (const option of q.options) {
                const line = document.createElement("div");
                const label = document.createElement("label");
                if (interactive) {
                  const input = document.createElement("input");
                  input.type = "radio";
                  input.name = "studio-decision-" + r.revision + "-" + i;
                  input.onchange = () => choices.set(i, option.label);
                  label.append(input, document.createTextNode(" "));
                }
                label.append(document.createTextNode(option.label +
                  (option.label === q.recommended && !/recommended/i.test(option.label) ? " (Recommended)" : "")));
                line.append(label);
                textElement("small", " — " + option.consequence, line);
                group.append(line);
              }
            }
            card.append(group);
          }
          if (interactive && structured) {
            const apply = document.createElement("button");
            apply.type = "button";
            apply.textContent = "Use selected decisions as correction";
            apply.onclick = () => {
              if (choices.size !== structured) {
                status.textContent = "Select an option for each structured decision first.";
                return;
              }
              const selected = questions.flatMap((q, i) => typeof q === "string" ? [] :
                [q.question + "\nDecision: " + choices.get(i)]).join("\n\n");
              const current = feedback.value.trim();
              const additional = previousApplied && current.startsWith(previousApplied)
                ? current.slice(previousApplied.length).trim() : current;
              const combined = [selected, additional].filter(Boolean).join("\n\n");
              if (combined.length > feedback.maxLength) {
                status.textContent = "Selected decisions and additional feedback exceed 2000 characters. Shorten the correction.";
                return;
              }
              previousApplied = selected;
              feedback.value = combined;
              updateButtons();
              status.textContent = "Decisions added to the correction box. Review and Save correction; no model called.";
              feedback.focus();
            };
            card.append(apply);
          }
        }
        function renderActivity(journal) {
          activity.replaceChildren();
          textElement("h3", "Verified execution activity", activity);
          textElement("p", "Local metadata only · Task studio-pilot-001 · No prompts, keys, or tool output in the journal.", activity);
          if (journal?.invalidLines) textElement("p", journal.invalidLines + " malformed journal line(s); evidence incomplete.", activity);
          if (!journal?.events?.length) {
            textElement("p", "No instrumented activity yet. Earlier runs cannot be reconstructed as verified logs.", activity);
            return;
          }
          const events = journal.events;
          const latestEvents = events.filter(e => e.revision === latest?.revision &&
            (e.executionId === latest?.executionId || !e.executionId));
          const count = (type, outcome) => latestEvents.filter(e => e.type === type && (!outcome || e.outcome === outcome)).length;
          const offered = latestEvents.find(e => e.type === "handoff.offered");
          const ack = offered && latestEvents.some(e => e.type === "handoff.acknowledged" &&
            e.artifactHash === offered.artifactHash && e.executionId === offered.executionId);
          textElement("p", "Latest revision · " + count("model.request") + " model requests · " +
            count("tool.result", "ok") + " completed tools · " + count("tool.result", "blocked") +
            " blocked tools · " + count("tool.result", "error") + " tool errors", activity);
          textElement("p", offered ? "Maya → Founder: " + (ack ? "acknowledged (matching artifact)" : "awaiting acknowledgement")
            : "No logged handoff for this revision. No downstream agent receipt verified.", activity);
          const detail = document.createElement("details");
          detail.open = latest?.status === "running";
          textElement("summary", "Execution timeline · " + journal.total + " events" + (journal.truncated ? " (latest 250 shown)" : ""), detail);
          const list = document.createElement("ol");
          list.style.cssText = "max-height:300px;overflow:auto;overflow-wrap:anywhere";
          const roleLabel = { "maya-ai-pm": "Maya", founder: "Founder", studio: "Studio" };
          const kind = {
            "revision.saved": "Correction saved", "run.started": "Run started", "route.selected": "Agent and engine selected",
            "context.prepared": "Context prepared", "model.request": "Model request initiated",
            "model.headers": "Provider HTTP response", "model.result": "Model response parsed",
            "tool.request": "Tool requested", "tool.result": "Tool result", "artifact.rejected": "Incomplete artifact rejected", "artifact.recovered": "Saved response recovered locally", "artifact.saved": "Contract saved",
            "handoff.offered": "Handoff offered", "handoff.acknowledged": "Handoff acknowledged",
            "run.completed": "Run completed", "run.failed": "Run failed", "run.interrupted": "Run interrupted"
          };
          for (const e of [...events].reverse()) {
            const fields = [new Date(e.at).toLocaleTimeString(), "r" + e.revision, roleLabel[e.actor] || e.actor || "Studio",
              kind[e.type] || e.type, e.requestedModel, e.reportedModel && "reported " + e.reportedModel,
              e.round && "round " + e.round, e.phase, e.httpStatus && "HTTP " + e.httpStatus, e.tool, e.outcome,
              e.artifactHash && "artifact " + e.artifactHash.slice(0, 12),
              e.baseArtifactHash && "base " + e.baseArtifactHash.slice(0, 12),
              Number.isFinite(e.sourceFiles) && e.sourceFiles + " context files",
              e.fromRole && e.toRole && ((roleLabel[e.fromRole] || e.fromRole) + " → " + (roleLabel[e.toRole] || e.toRole)),
              Number.isFinite(e.durationMs) && e.durationMs + " ms",
              Number.isFinite(e.inputTokens) && e.inputTokens + " input tokens",
              Number.isFinite(e.outputTokens) && e.outputTokens + " output tokens", e.errorKind,
              e.executionId && "run " + e.executionId.slice(0, 8)].filter(x => x !== false && x != null && x !== "");
            textElement("li", fields.join(" · "), list);
          }
          detail.append(list);
          activity.append(detail);
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
              : action === "recover" ? "Saved contract recovered. Review founder decisions; no model called."
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
        panel.append(feedback, controls, activity, evidence);
        item.append(panel);
        save.disabled = run.disabled = accept.disabled = recover.disabled = true;
        recover.hidden = true;
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
