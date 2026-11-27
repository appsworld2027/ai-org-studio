import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync, symlinkSync } from "node:fs";
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
    writeFileSync(gh, `#!/bin/sh
case "$4" in
  repos/example/studio-private-fixture) printf '%s\\n' '{"full_name":"example/studio-private-fixture","visibility":"private"}' ;;
  repos/example/studio-private-fixture/actions/workflows?per_page=100) printf '%s\\n' '{"total_count":0,"workflows":[]}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
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
    await work({ base, remote, dir, p, garage, note, offline, gh, fakeUrl });
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

test("Garage refuses a different private push repository even if it is private", async () => {
  await fixture(async ({ remote, dir, p, garage, note }) => {
    const original = git("--git-dir", remote, "rev-parse", "main");
    git("-C", dir, "remote", "set-url", "--push", "origin", "https://github.com/example/different-private.git");
    writeFileSync(note, "# Fictional checkpoint\nKeep this private\n");
    const result = await garage.save(p, "must not push");
    assert.equal(result.pushed, false);
    assert.match(result.reason, /exact configured private/);
    assert.equal((await garage.pull()).ok, false);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), original);
    assert.match(readFileSync(note, "utf8"), /Keep this private/);
  });
});

test("Garage verifies canonical GitHub identity as well as visibility", async () => {
  await fixture(async ({ remote, p, garage, note, gh }) => {
    const original = git("--git-dir", remote, "rev-parse", "main");
    writeFileSync(gh, '#!/bin/sh\nprintf \'%s\\n\' \'{"full_name":"example/other","visibility":"private"}\'\n', {mode:0o755});
    writeFileSync(note, "# Fictional checkpoint\nDo not publish\n");
    assert.equal((await garage.save(p, "blocked")).pushed, false);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), original);
  });
});

test("Garage never reads or indexes a symlink and blocks a symlink-bearing checkpoint", async () => {
  await fixture(async ({ base, remote, dir, p, garage }) => {
    const original = git("--git-dir", remote, "rev-parse", "main");
    const outside = join(base, "outside.txt");
    writeFileSync(outside, "FICTIONAL-OUTSIDE-ISOLATION-SENTINEL\n");
    symlinkSync(outside, join(dir, p.id, "notes", "linked.txt"));
    assert.throws(() => garage.readFile(p, "notes/linked.txt"), /symbolic links/);
    assert.throws(() => garage.ensureProduct({...p, id:"../escape"}), /Invalid Garage product ID/);
    assert.equal(garage.files(p).some(x => x.path === "notes/linked.txt"), false);
    garage.rebuildIndex(p);
    assert.doesNotMatch(readFileSync(join(dir,p.id,"INDEX.md"),"utf8"), /FICTIONAL-OUTSIDE-ISOLATION-SENTINEL/);
    const result = await garage.save(p, "blocked symbolic link");
    assert.equal(result.pushed, false);
    assert.match(result.reason, /symbolic links|regular files/);
    assert.equal(git("--git-dir", remote, "rev-parse", "main"), original);
  });
});

test("Garage redacts fictional key markers in unusual filenames before commit or index", async () => {
  await fixture(async ({ remote, dir, p, garage }) => {
    const marker = "sk-" + "a".repeat(35);
    writeFileSync(join(dir,p.id,"notes","résumé with space.txt"), "# " + marker + "\n");
    const result = await garage.save(p, "redacted fictional marker");
    assert.equal(result.pushed,true);
    assert.ok(result.redacted>=1);
    const saved = git("--git-dir",remote,"show","main:synthetic/notes/résumé with space.txt");
    const index = git("--git-dir",remote,"show","main:synthetic/INDEX.md");
    assert.doesNotMatch(saved,new RegExp(marker));
    assert.doesNotMatch(index,new RegExp(marker));
    assert.match(saved,/REDACTED/);
  });
});

test("Garage blocks an active downstream mirror without verification but permits exact private reads", async () => {
  await fixture(async ({ remote, p, garage, note, gh }) => {
    const original = git("--git-dir", remote, "rev-parse", "main");
    writeFileSync(gh, `#!/bin/sh
case "$4" in
  repos/example/studio-private-fixture) printf '%s\\n' '{"full_name":"example/studio-private-fixture","visibility":"private"}' ;;
  repos/example/studio-private-fixture/actions/workflows?per_page=100) printf '%s\\n' '{"total_count":1,"workflows":[{"name":"GitLab Mirror","path":".github/workflows/mirror.yml","state":"active"}]}' ;;
  *) exit 1 ;;
esac
`, {mode:0o755});
    assert.equal((await garage.pull()).ok,true);
    writeFileSync(note,"# Mirror must be verified\nFictional data remains local\n");
    const result=await garage.save(p,"blocked external mirror");
    assert.equal(result.pushed,false);
    assert.match(result.reason,/unverified active mirror/);
    assert.equal(git("--git-dir",remote,"rev-parse","main"),original);
  });
});
