import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFounderInbox } from "../server/founder-inbox.mjs";

test("Founder task survives restart and duplicate submission", () => {
  const dir = mkdtempSync(join(tmpdir(), "founder-inbox-"));

  try {
    const input = {
      requestId: "founder-pilot-001",
      title: "Improve founder feedback",
      description: "Build the correction workflow"
    };

    const first = createFounderInbox(dir).submit(input);
    const recovered = createFounderInbox(dir);

    assert.deepEqual(recovered.submit(input), first);
    assert.equal(recovered.list().length, 1);
    assert.equal(first.status, "queued");
    assert.equal(first.executionVerified, false);

    assert.throws(() => recovered.submit({
      ...input, description: "Different work"
    }));

    assert.throws(() => recovered.submit({
      ...input, requestId: "../invalid"
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
