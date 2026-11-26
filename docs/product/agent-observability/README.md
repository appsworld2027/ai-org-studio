# Agent execution evidence

## Founder-facing meaning

An assignment or workflow title is a routing signal, not proof that a model ran.
A successful run is not proof that its output was accepted or that another
agent consumed it. Studio separates these evidence levels.

- The **Founder Inbox** shows an execution timeline for the supervised synthetic
  pilot. Actual model requests, HTTP responses, parsed responses, tool requests
  and outcomes, artifacts, and founder acknowledgements are recorded.
- The **Agent board** reads recent GitHub workflow jobs and relevant steps for
  the selected product. It links to the exact run and distinguishes an active
  engine step from setup, a handover check from a receiving agent's receipt,
  and inferred workflow attribution from identified role execution.

## Local metadata journal

The preview writes **`$STUDIO_HOME/founder-pilot/execution-events.jsonl`**.
Every line is a timestamped JSON event with a request ID, revision, event ID
and (for execution events) execution ID. The file is created owner-only and
events are flushed before returning. Only allowlisted metadata is appended:
role, model, round, tool name/outcome, status, duration, reported token counts,
error category, and SHA-256 contract digest. No raw prompts, founder feedback,
credentials, tool arguments/output, or HTTP bodies are written to the journal.
Missing provider usage/model metadata is unknown, not zero or guessed.

Discovery preloads selected committed source excerpts and records context size
and file count. It has at most three model rounds, with the last reserved for
a tool-free final artifact. Earlier invalid text artifacts are rejected and
may use the reserved final round once. The journal identifies exploration and
finalization; it does not count incomplete output as a delivered contract.

A saved contract is logged before a handoff is offered. A founder acknowledgement
must refer to the same execution ID and artifact digest for an instrumented
contract. A revision can reference a prior contract digest and correction count.
A failed or interrupted run is not counted as complete. Prior uninstrumented
runs stay uninstrumented; there is no backfilled proof. A format-rejected response can be recovered explicitly, without a model call,
only when the saved attempt and actual instrumented model response and prior
validation failure match the same execution. Recovery appends a separate
artifact.recovered event and handoff; it never rewrites the original run.failed
as a successful run. Structured founder questions preserve options and
recommendations; unresolved questions still block acceptance. The journal is local
persistent evidence, not a tamper-proof external audit service, and does not
survive loss of the underlying home directory.

## Canonical AI Org workflow evidence

The existing reusable AI Org agent-worker records routing, onboarding, engine
execution, validation, handover checks, and logs in GitHub Actions. Studio
links observed run/job/step statuses. A green handover check is evidence that
a producer's packet passed validation—not that the next agent read it. A
successful chaining step similarly is not a receipt.

For live multi-agent coordination, the canonical worker must emit a producer
handoff and a separate consumer receipt with the same work-item ID, immutable
artifact digest/commit, producing and receiving agent/run IDs and timestamps.
Only that matched pair should be labelled confirmed coordination. The supervised local pilot now supports **Maya → Arjun → Quinn** with a
separate execution ID per receiving role, source execution ID, input/output
artifact digests, actual provider request/response events, and a validated
receipt for every acceptance criterion. The incoming artifact and role profile
are passed to the model; completion requires an observed HTTP 200, a parsed
response, matching hashes and exactly one coverage entry per criterion.
Receipts establish correlated artifact exchange, not correctness or access
to private model reasoning. If validation fails, the chain stops. A restarted
preview marks active work interrupted; retry only reuses stages with matching
persisted receipts and output evidence.

The Founder Inbox button **Run Maya, then Arjun and Quinn** explicitly
requests this sequence. New discovery must finish with no open founder
questions before draft planning starts; the final contract still needs founder
acceptance. **Run Arjun and Quinn (draft plans)** allows explicit continuation
from a valid latest contract. Actual model output is stored in private revision
history at `$STUDIO_HOME/founder-pilot/studio-pilot-001.json`; metadata is in the
journal above. Latest revision is shown first, older revisions are expandable.
Arjun produces engineering tasks and Quinn produces test designs, not code
changes or executed tests. Their roles can use the same underlying model.

The local synthetic pilot is not evidence that all agents work, nor does it
unify canonical GitHub worker logs. The canonical workflow has separate run,
job and artifact logs; matched downstream receipts on that workflow remain
unverified. The canonical worker remains disabled in Studio until approved
and demonstrated end-to-end. Studio does not deploy or merge automatically.

## Validation

`node --test test/founder-pilot.test.mjs test/execution-journal.test.mjs test/coordination-pilot.test.mjs`
covers metadata-only logging, read/blocked tools, durable revision state and
matched acknowledgement, and the distinction between active workflow and
verified receiving-agent receipt. Tests use stand-in model responses; a live
preview test is still needed to prove provider connectivity and instrumentation.
