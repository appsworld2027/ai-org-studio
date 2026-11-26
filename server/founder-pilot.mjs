import {
  mkdirSync, readFileSync, writeFileSync,
  existsSync, renameSync
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PROVIDERS } from "./providers.mjs";
import { readStream } from "./agent.mjs";

export function createFounderPilot({
  dir, inbox, orgDir, keyFile
}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const active = new Set();
  const pilotId = "studio-pilot-001";

  const file = id => join(dir, `${id}.json`);

  function history(id) {
    if (id !== pilotId) throw new Error("Outside pilot scope");

    if (!existsSync(file(id))) return [];

    return JSON.parse(readFileSync(file(id), "utf8"));
  }

  function save(id, revisions) {
    const tmp = file(id) + ".tmp";

    writeFileSync(tmp, JSON.stringify(revisions, null, 2), {
      mode: 0o600
    });

    renameSync(tmp, file(id));
  }

  async function invoke(stage, instruction) {
    const router = await import(
      pathToFileURL(
        join(orgDir, "scripts/agent-router.mjs")
      ).href
    );

    const route = router.route({
      labels: [stage, "engine:free"],
      engines: { free: true, codex: false, claude: false }
    });

    if (route.action !== "run" ||
        route.engine !== "free") {
      throw new Error("Requested agent unavailable");
    }

    const model = route.free_model.replace(
      /^nvidia_nim\//, ""
    );

    if (!PROVIDERS.nvidia.models.includes(model)) {
      throw new Error("Model outside pilot allowlist");
    }

    const key = JSON.parse(
      readFileSync(keyFile, "utf8")
    ).nvidia?.key;

    if (typeof key !== "string" || !key) {
      throw new Error("NVIDIA connection unavailable");
    }

    const agent = router.agentInfo(route.role);
    const profile = readFileSync(
      join(orgDir, "org/agents", `${route.role}.md`),
      "utf8"
    );

    const startedAt = new Date().toISOString();

    console.log(
      `[AI Org pilot] ${agent.name} started: ${model}`
    );

    const response = await fetch(
      `${PROVIDERS.nvidia.base}/chat/completions`,
      {
        method: "POST",
        signal: AbortSignal.timeout(150000),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          max_tokens: 1400,
          stream: true,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: profile +
                "\nThis is a restricted Studio discovery pilot." +
                " Return a concise written artifact only." +
                " Do not claim code changes, tests, deployments" +
                " or tool execution."
            },
            { role: "user", content: instruction }
          ]
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `Free provider returned HTTP ${response.status}`
      );
    }

    const streamed = await readStream(response.body);
    const output = streamed.text;

    if (typeof output !== "string" || !output.trim()) {
      throw new Error("Agent returned no usable artifact");
    }

    const record = {
      executionId: randomUUID(),
      agent: agent.name,
      role: route.role,
      requestedModel: model,
      reportedModel: null,
      startedAt,
      completedAt: new Date().toISOString(),
      inputTokens: streamed.usage?.input ?? null,
      outputTokens: streamed.usage?.output ?? null,
      cost: null,
      output
    };

    console.log(`[AI Org pilot] ${agent.name} completed`);

    return record;
  }

  return {
    history,

    async run({ requestId, feedback = "" }) {
      if (requestId !== pilotId) {
        throw new Error("Only the synthetic pilot is enabled");
      }

      if (typeof feedback !== "string" ||
          feedback.length > 2000) {
        throw new Error("Invalid feedback");
      }

      if (active.has(requestId)) {
        throw new Error("Agent work already in progress");
      }

      const task = inbox.list().find(
        t => t.requestId === requestId
      );

      if (!task) throw new Error("Founder task not found");

      const revisions = history(requestId);
      const previous = [...revisions].reverse().find(
        r => r.status === "reviewed"
      );

      if (previous && previous.feedback === feedback.trim()) {
        return previous;
      }

      if (revisions.length >= 3) {
        throw new Error("Pilot revision limit reached");
      }

      active.add(requestId);

      const record = {
        revision: revisions.length + 1,
        feedback: feedback.trim(),
        status: "running",
        agents: [],
        createdAt: new Date().toISOString()
      };

      const failed = revisions.at(-1);

      if (failed?.status === "failed" &&
          failed.feedback === feedback.trim()) {
        Object.assign(record, failed, { status: "running" });
        delete record.error;
        revisions[revisions.length - 1] = record;
      } else {
        revisions.push(record);
      }

      try {
        save(requestId, revisions);

        const discovery = record.agents[0] || await invoke(
          "ai:discovery",
          [
            "Founder objective:",
            task.description,
            previous
              ? "Previous contract:\n" +
                previous.agents[0].output
              : "",
            feedback
              ? "Founder correction:\n" + feedback
              : "",
            "Produce a concise feature contract with",
            "acceptance criteria and meaningful edge cases.",
            "Preserve valid previous requirements.",
            "Flag material founder decisions."
          ].join("\n")
        );

        if (!record.agents.length) record.agents.push(discovery);
        record.status = "reviewing";
        save(requestId, revisions);

        const review = await invoke(
          "ai:review",
          [
            "Independently review this feature contract.",
            "Identify missing acceptance criteria,",
            "security risks and unresolved edge cases.",
            "Check whether the founder feedback was addressed.",
            "Provide a clear verdict and required corrections.",
            "Founder objective: " + task.description,
            "Founder feedback: " + feedback,
            "Contract: " + discovery.output
          ].join("\n")
        );

        record.agents.push(review);
        record.status = "reviewed";
        record.completedAt = new Date().toISOString();

        save(requestId, revisions);
        return record;

      } catch (error) {
        record.status = "failed";
        record.error = String(error.message).slice(0, 250);
        save(requestId, revisions);
        throw error;

      } finally {
        active.delete(requestId);
      }
    }
  };
}
