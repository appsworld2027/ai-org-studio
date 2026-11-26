// Test process only: Node's permission model disables fsyncSync even on
// explicitly writable files. Do not change production journal durability.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, resolve, sep } from "node:path";

if (!process.permission || !process.env.TMPDIR || !process.permission.has("fs.write", process.env.TMPDIR))
  throw Error("Founder test preload requires the isolated permission sandbox");
const scratch = resolve(process.env.TMPDIR) + sep;
const journalFDs = new Set();
const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
fs.openSync = function(path, ...args) {
  const fd = open.call(this, path, ...args);
  if (typeof path === "string" && resolve(path).startsWith(scratch) &&
      basename(path) === "execution-events.jsonl") journalFDs.add(fd);
  return fd;
};
fs.closeSync = function(fd, ...args) {
  try { return close.call(this, fd, ...args); }
  finally { journalFDs.delete(fd); }
};
fs.fsyncSync = function(fd, ...args) {
  try { return sync.call(this, fd, ...args); }
  catch(e) {
    if (!journalFDs.has(fd) || e.code !== "ERR_ACCESS_DENIED" ||
        !/fsync API is disabled when Permission Model is enabled/i.test(e.message)) throw e;
    // A real append was made in temporary storage; only its physical flush
    // is simulated. This test does not certify power-loss durability.
  }
};
syncBuiltinESMExports();
