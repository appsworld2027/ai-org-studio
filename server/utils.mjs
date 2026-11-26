// Shared utilities for Studio server modules
import { execFile } from "node:child_process";

const GH = process.env.STUDIO_GH || "gh";

export const run = (cmd, args, opts = {}) => new Promise((ok, fail) => execFile(cmd, args, { timeout: 120000, maxBuffer: 32 << 20, ...opts }, (e, out, err) => e ? fail(new Error((err || e.message).toString().trim().split("\n").slice(-1)[0])) : ok(out)));

export const gh = (args, timeout = 20000) => run(GH, args, { timeout });

export const ghJson = async (path) => JSON.parse(await gh(["api", path]) || "null");