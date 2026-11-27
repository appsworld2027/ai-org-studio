import {
  mkdirSync, readFileSync, readdirSync, existsSync,
  linkSync, unlinkSync, writeFileSync, renameSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const validRequestId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
const validRepository = (value) =>
  value == null || (typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value));

export function createFounderInbox(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const fileFor = (id) => join(dir, `${id}.json`);
  function read(id) {
    return JSON.parse(readFileSync(fileFor(id), "utf8"));
  }
  function write(task) {
    const temp = join(dir, `.tmp-${randomUUID()}`);
    try {
      writeFileSync(temp, JSON.stringify(task, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temp, fileFor(task.requestId));
    } finally {
      try { unlinkSync(temp); } catch {}
    }
    return task;
  }

  return {
    submit(input = {}) {
      const { requestId, title, description, productId = null, product = "Unassigned product", repository = null } = input;
      if (
        !validRequestId(requestId) ||
        typeof title !== "string" || !title.trim() || title.length > 200 ||
        typeof description !== "string" || !description.trim() || description.length > 20000 ||
        (productId !== null && (typeof productId !== "string" || !/^[a-z0-9-]{1,60}$/.test(productId))) ||
        typeof product !== "string" || !product.trim() || product.length > 120 ||
        !validRepository(repository)
      ) {
        throw new Error("Invalid founder task");
      }

      const task = {
        requestId,
        title: title.trim(),
        description: description.trim(),
        productId,
        product: product.trim(),
        repository,
        status: "queued",
        assignedRole: "maya-ai-pm",
        enginePolicy: "free-only",
        executionVerified: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const file = fileFor(requestId);
      const temp = join(dir, `.tmp-${randomUUID()}`);

      try {
        writeFileSync(temp, JSON.stringify(task, null, 2), { mode: 0o600, flag: "wx" });
        try {
          linkSync(temp, file);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const existing = read(requestId);
          if (
            existing.title !== task.title ||
            existing.description !== task.description ||
            existing.productId !== task.productId ||
            existing.repository !== task.repository
          ) {
            throw new Error("Request ID already used for different work");
          }
          return existing;
        }
        return task;
      } finally {
        try { unlinkSync(temp); } catch {}
      }
    },

    update(requestId, patch = {}) {
      if (!validRequestId(requestId) || !existsSync(fileFor(requestId))) {
        throw new Error("Founder task not found");
      }
      const allowed = new Set([
        "status", "githubIssueNumber", "githubIssueUrl", "assignedRole",
        "engine", "provider", "model", "dispatchError", "dispatchedAt",
        "executionVerified"
      ]);
      const safePatch = Object.fromEntries(
        Object.entries(patch).filter(([key]) => allowed.has(key))
      );
      const task = { ...read(requestId), ...safePatch, updatedAt: new Date().toISOString() };
      return write(task);
    },

    get(requestId) {
      if (!validRequestId(requestId) || !existsSync(fileFor(requestId))) return null;
      return read(requestId);
    },

    list() {
      return readdirSync(dir)
        .filter((f) => /^[a-zA-Z0-9_-]{8,100}\.json$/.test(f))
        .map((f) => read(f.slice(0, -5)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
  };
}
