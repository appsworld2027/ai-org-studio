// A write-once, metadata-only dispatch fence. An uncertain attempt is never
// automatically cleared. All cooperating controllers must use the SAME durable
// POSIX filesystem directory (exclusive create and fsync semantics required).
import { constants, mkdirSync, lstatSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

const sha = text => createHash("sha256").update(text).digest("hex");
const hex = /^[0-9a-f]{64}$/;
const hold = () => new Error("GitHub issue creation outcome uncertain; reconcile before retrying");
const privateFile = info => (info.mode & 0o077) === 0 &&
  (typeof process.getuid !== "function" || info.uid === process.getuid());

function syncDirectory(dir){
  const fd=openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function claimDispatch(dir, repository, requestId, fingerprint) {
  if (typeof dir !== "string" || !dir || !hex.test(fingerprint)) throw new Error("Durable dispatch fence unavailable");
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch(error) { if(error.code!=="EEXIST")throw hold(); }
  const info = lstatSync(dir);
  if (!info.isDirectory() || !privateFile(info)) throw new Error("Durable dispatch fence directory is not private");
  // A newly created claims directory must itself be durable before any POST.
  // Sync even when another controller won the mkdir race.
  try { syncDirectory(dirname(dir)); } catch { throw hold(); }
  const path = join(dir, sha(JSON.stringify([repository.toLowerCase(), requestId])) + ".claim");
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw hold();
    // Partial, corrupt, non-regular or symlinked claims are holds, not absence.
    try {
      const old = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let recorded;
      try {
        const stat = fstatSync(old);
        if (!stat.isFile() || !privateFile(stat) || stat.size !== 65) throw hold();
        recorded = readFileSync(old, "utf8");
      } finally { closeSync(old); }
      if (!/^[0-9a-f]{64}\n$/.test(recorded)) throw hold();
      if (recorded.slice(0,64) !== fingerprint) throw new Error("Conflicting request ID reuse");
      return false;
    } catch(error) {
      if (error.message === "Conflicting request ID reuse") throw error;
      throw hold();
    }
  }
  try {
    writeFileSync(fd, fingerprint + "\n", "utf8");
    fsyncSync(fd);
  } catch { throw hold(); }
  finally { closeSync(fd); }
  // If the controller dies before durable commit, retain the file and do not POST.
  try {
    syncDirectory(dir);
  } catch { throw hold(); }
  return true;
}

export const dispatchFingerprint = (title, body, labels) => sha(JSON.stringify([title.trim(), body, [...labels].sort()]));
