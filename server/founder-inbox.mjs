import {
  mkdirSync, readFileSync, readdirSync,
  linkSync, unlinkSync, writeFileSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function createFounderInbox(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  function read(id) {
    return JSON.parse(
      readFileSync(join(dir, `${id}.json`), "utf8")
    );
  }

  return {
    submit(input = {}) {
      const { requestId, title, description } = input;

      if (
        typeof requestId !== "string" ||
        !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) ||
        typeof title !== "string" ||
        !title.trim() || title.length > 200 ||
        typeof description !== "string" ||
        !description.trim() ||
        description.length > 20000
      ) {
        throw new Error("Invalid founder task");
      }

      const task = {
        requestId,
        title: title.trim(),
        description: description.trim(),
        product: "AI Org Studio",
        repository: "appsworld2027/ai-org-studio",
        status: "queued",
        assignedRole: "maya-ai-pm",
        enginePolicy: "free-only",
        executionVerified: false,
        createdAt: new Date().toISOString()
      };

      const file = join(dir, `${requestId}.json`);
      const temp = join(dir, `.tmp-${randomUUID()}`);

      try {
        writeFileSync(
          temp,
          JSON.stringify(task, null, 2),
          { mode: 0o600, flag: "wx" }
        );

        try {
          linkSync(temp, file);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;

          const existing = read(requestId);

          if (
            existing.title !== task.title ||
            existing.description !== task.description
          ) {
            throw new Error(
              "Request ID already used for different work"
            );
          }

          return existing;
        }

        return task;
      } finally {
        try { unlinkSync(temp); } catch {}
      }
    },

    list() {
      return readdirSync(dir)
        .filter(f => /^[a-zA-Z0-9_-]{8,100}\.json$/.test(f))
        .map(f => read(f.slice(0, -5)))
        .sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        );
    }
  };
}
