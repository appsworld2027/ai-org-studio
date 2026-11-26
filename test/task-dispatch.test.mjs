import test from "node:test";
import assert from "node:assert/strict";
import { dispatchTask } from "../server/task-dispatch.mjs";

const manifest = {
  executionPolicy: {
    enabled: true,
    allowedEngines: ["free"],
    allowPaidFallback: false
  }
};

function fixture() {
  const tasks = new Map();
  let writes = 0;

  const github = {
    async ensureTask(task) {
      if (!tasks.has(task.requestId)) {
        writes++;
        tasks.set(task.requestId, {
          ...task,
          number: writes
        });
      }
      return tasks.get(task.requestId);
    }
  };

  return {
    tasks,
    writes: () => writes,
    input: {
      manifest,
      repository: "appsworld2027/ai-org-studio",
      title: "Founder feedback pilot",
      description: "Create a founder feedback workflow",
      requestId: "pilot-feedback-001",
      availableEngines: { free: true },
      github
    }
  };
}

test("Disabled policy prevents GitHub writes", async () => {
  const f = fixture();

  const result = await dispatchTask({
    ...f.input,
    manifest: {
      executionPolicy: {
        ...manifest.executionPolicy,
        enabled: false
      }
    }
  });

  assert.equal(result.status, "paused");
  assert.equal(f.writes(), 0);
});

test("Unavailable free engine prevents task submission", async () => {
  const f = fixture();

  const result = await dispatchTask({
    ...f.input,
    availableEngines: { free: false, codex: true }
  });

  assert.equal(result.status, "paused");
  assert.equal(f.writes(), 0);
});

test("Task is assigned to discovery using free engine", async () => {
  const f = fixture();
  const result = await dispatchTask(f.input);

  assert.equal(result.status, "submitted");
  assert.equal(result.assignedRole, "maya-ai-pm");
  assert.equal(result.engine, "free");
  assert.equal(result.executionVerified, false);

  const task = f.tasks.get(f.input.requestId);

  assert.deepEqual(task.labels, [
    "ai:discovery",
    "engine:free"
  ]);

  assert.equal(f.writes(), 1);
});

test("Duplicate request reuses task through adapter", async () => {
  const f = fixture();

  const first = await dispatchTask(f.input);
  const second = await dispatchTask(f.input);

  assert.equal(first.taskNumber, second.taskNumber);
  assert.equal(f.writes(), 1);
});

test("Parent Plus cannot be modified by Studio pilot", async () => {
  const f = fixture();

  await assert.rejects(
    dispatchTask({
      ...f.input,
      repository: "appsworld2027/Parent-plus-"
    }),
    /outside the pilot scope/
  );

  assert.equal(f.writes(), 0);
});

test("Invalid input creates no task", async () => {
  const f = fixture();

  await assert.rejects(
    dispatchTask({ ...f.input, title: "" }),
    /Invalid task input/
  );

  assert.equal(f.writes(), 0);
});

test("Missing GitHub adapter is rejected", async () => {
  const f = fixture();

  await assert.rejects(
    dispatchTask({ ...f.input, github: undefined }),
    /adapter unavailable/
  );
});

test("Unconfirmed GitHub task cannot report success", async () => {
  const f = fixture();

  await assert.rejects(
    dispatchTask({
      ...f.input,
      github: { ensureTask: async () => ({}) }
    }),
    /did not confirm/
  );
});
