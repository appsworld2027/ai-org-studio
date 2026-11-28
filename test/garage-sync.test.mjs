import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeGarage } from "../server/garage.mjs";

const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync(gitBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function fixture(work) {
  const base = mkdtempSync(join(tmpdir(), "studio-garage-sync-"));
  const remote = join(base, "remote.git"), dir = join(base, "clone"), shim = join(base, "bin");
  const offline = join(base, "offline"), gh = join(shim, "gh");
  const fakeUrl = "https://github.com/example/studio-private-fixture.git";
  const previous = process.env.PATH;
  try {
    git("init", "-q", "--bare", "-b", "main", remote);
    git("clone", "-q", remote, dir);
    git("-C", dir, "config", "user.name", "Garage Fixture");
    git("-C", dir, "config", "user.email", "fixture@example.invalid");
    const p = { id: "synthetic", name: "Synthetic", repo: "example/synthetic", dir: base };
    const garage = makeGarage({ dir, gh, repo: "example/studio-private-fixture" });
    garage.ensureProduct(p);
    garage.rebuildIndex(p);
    const note = join(dir, p.id, "MEMORY.md");
    writeFileSync(note, "# Shared decision\nInitial synthetic decision\n");
    git("-C", dir, "add", "-A");
    git("-C", dir, "commit", "-qm", "seed");
    git("-C", dir, "push", "-q", "origin", "HEAD");
    git("-C", dir, "remote", "set-url", "origin", fakeUrl);
    mkdirSync(shim);
    writeFileSync(gh, '#!/bin/sh\n[ "$4" = repos/example/studio-private-fixture ] || exit 1\nprintf "private\\n"\n', { mode: 0o755 });
    // Only the exact fixture transport is mapped to a local bare repo. No external access.
    writeFileSync(join(shim, "git"), `#!/bin/sh
if [ "$1" = "-C" ] && [ "$2" = "${dir}" ] && { [ "$3" = "push" ] || [ "$3" = "pull" ]; }; then
  [ ! -e "${offline}" ] || { echo "simulated outage" >&2; exit 1; }
  root="$2"; shift 2
  GIT_ALLOW_PROTOCOL=file exec "${gitBin}" -C "$root" -c "url.${remote}.insteadOf=${fakeUrl}" "$@"
fi
exec "${gitBin}" "$@"
`, { mode: 0o755 });
    process.env.PATH = shim + ":" + previous;
    await work({ base, remote, dir, p, garage, note, offline });
  } finally {
    process.env.PATH = previous;
    rmSync(base, { recursive: true, force: true });
  }
}

test("Garage retries an unpushed local checkpoint even when no further files changed", async () => {
  await fixture(async ({ remote, dir, p, garage, note, offline }) => {
    const originalRemoteHead = git("--git-dir", remote, "rev-parse", "main");
    writeFileSync(note, "# Shared decision\nRecover this checkpoint\n");
    writeFileSync(offline, "offline");
    const interrupted = await garage.save(p, "checkpoint during outage");
    assert.equal(interrupted.pushed, false);
    assert.equal(git("-C", dir, "status", "--porcelain"), "");
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), originalRemoteHead);
    unlinkSync(offline);
    const recovered = await garage.save(p, "retry with no new changes");
    assert.equal(recovered.ok, true);
    assert.equal(recovered.pushed, true);
    assert.equal(recovered.changed, 0);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), git("-C", dir, "rev-parse", "HEAD"));
    assert.match(git("--git-dir", remote, "show", "main:synthetic/MEMORY.md"), /Recover this checkpoint/);
  });
});

test("Garage rejects conflicting concurrent memory instead of automatically discarding a decision", async () => {
  await fixture(async ({ base, remote, dir, p, garage, note }) => {
    const other = join(base, "other");
    git("clone", "-q", remote, other);
    writeFileSync(join(other, p.id, "MEMORY.md"), "# Shared decision\nRemote founder decision\n");
    git("-C", other, "add", "-A");
    git("-C", other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "remote decision");
    git("-C", other, "push", "-q", "origin", "HEAD");
    writeFileSync(note, "# Shared decision\nDifferent local founder decision\n");
    const result = await garage.save(p, "local competing decision");
    assert.equal(result.ok, false);
    assert.equal(result.pushed, false);
    assert.match(result.reason, /conflict|rebase/i);
    assert.equal(git("-C", dir, "status", "--porcelain"), "", "unfinished rebases must be aborted");
    assert.match(readFileSync(note, "utf8"), /Different local founder decision/);
    assert.match(git("--git-dir", remote, "show", "main:synthetic/MEMORY.md"), /Remote founder decision/);
  });
});

test("A-12 pull reports recovered memory and network outage truthfully", async () => {
  await fixture(async ({ base, remote, dir, p, garage, note, offline }) => {
    const other = join(base, "recovery-second-clone");
    git("clone", "-q", remote, other);
    writeFileSync(join(other, p.id, "MEMORY.md"), "# Shared decision\nNew remote synthetic decision\n");
    git("-C", other, "add", "-A");
    git("-C", other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "new remote decision");
    git("-C", other, "push", "-q", "origin", "HEAD");
    const recovered = await garage.pull();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.available, true);
    assert.equal(recovered.head, git("-C", dir, "rev-parse", "HEAD"));
    assert.match(readFileSync(note, "utf8"), /New remote synthetic decision/);
    writeFileSync(offline, "offline");
    const failed = await garage.pull();
    assert.equal(failed.ok, false);
    assert.equal(failed.available, true);
    assert.match(failed.reason, /recovery/i);
    assert.match(readFileSync(note, "utf8"), /New remote synthetic decision/);
    unlinkSync(offline);
    assert.equal((await garage.pull()).ok, true);
  });
});
