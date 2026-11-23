// Where the Studio is running, and the browser link for a port there.
// Google Cloud Shell: https://<port>-<WEB_HOST>  (WEB_HOST is set in Cloud Shell terminals)
// GitHub Codespaces:  https://<CODESPACE_NAME>-<port>.<GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN>
// Anything else: STUDIO_PUBLIC_URL if set, else http://localhost:<port> (use an SSH tunnel or the host's port forwarding).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

function cloudShellHost(env) {
  if (env.WEB_HOST) return env.WEB_HOST;
  if (!env.CLOUD_SHELL && !env.DEVSHELL_PROJECT_ID && !env.GOOGLE_CLOUD_SHELL) return "";
  // Background processes may not inherit WEB_HOST; the login profile usually exports it.
  for (const f of ["/etc/profile.d/cloudshell_web_host.sh", `${homedir()}/.customize_environment`]) {
    try { const m = readFileSync(f, "utf8").match(/WEB_HOST=["']?([a-z0-9.-]+)/i); if (m) return m[1]; } catch { /* not there */ }
  }
  return "";
}
export function platform(env = process.env) {
  if (env.CODESPACE_NAME) return { id: "codespaces", name: "GitHub Codespaces" };
  if (env.WEB_HOST || env.CLOUD_SHELL || env.DEVSHELL_PROJECT_ID) return { id: "cloudshell", name: "Google Cloud Shell" };
  if (env.GITPOD_WORKSPACE_URL) return { id: "gitpod", name: "Gitpod" };
  return { id: "other", name: "this machine" };
}
// The address the Studio was last opened at (saved by the server on first use), if it is for this port.
function learnedUrl(port, env) {
  try {
    const u = readFileSync(`${env.STUDIO_HOME || `${homedir()}/.ai-org-studio`}/public-url`, "utf8").trim();
    if (/^https:\/\/\S+$/.test(u) && (u.includes(`//${port}-`) || u.includes(`-${port}.`))) return u;
  } catch { /* not yet */ }
  return "";
}
export function publicUrl(port, env = process.env) {
  if (env.STUDIO_PUBLIC_URL) return env.STUDIO_PUBLIC_URL.replace(/\/$/, "");
  if (env.CODESPACE_NAME) return `https://${env.CODESPACE_NAME}-${port}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev"}`;
  const ws = cloudShellHost(env); if (ws) return `https://${port}-${ws}`;
  const learned = learnedUrl(port, env); if (learned) return learned;
  if (env.GITPOD_WORKSPACE_URL) return env.GITPOD_WORKSPACE_URL.replace("https://", `https://${port}-`);
  return `http://localhost:${port}`;
}
