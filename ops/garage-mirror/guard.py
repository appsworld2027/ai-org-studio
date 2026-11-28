"""Proposed Garage mirror boundary. Synthetic tests only in the Studio repo."""
import base64
import json
import os
import re
import subprocess
import urllib.error
import urllib.request

SOURCE = "appsworld2027/studio-garage"
TARGET_ID = 89569412
TARGET_PATH = "amverse-group/studio-garage"
TARGET_URL = "https://gitlab.com/" + TARGET_PATH + ".git"
OWNER = "ankit_mittal_mds02"
GH = "https://api.github.com/repos/" + SOURCE
GL = "https://gitlab.com/api/v4/projects/" + str(TARGET_ID)
MAX = 1024 * 1024

class Blocked(Exception):
    pass

class RejectRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Blocked("redirect refused")

def request(url, token, host):
    # Fixed endpoints only; credentials cannot be forwarded to redirects.
    if host == "github" and url in (GH, GH + "/git/ref/heads/main"):
        headers = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json"}
    elif host == "gitlab" and url in (GL, GL + "/members/all?per_page=100", GL + "/repository/branches/main"):
        headers = {"PRIVATE-TOKEN": token, "Accept": "application/json"}
    else:
        raise Blocked("endpoint refused")
    headers["User-Agent"] = "ai-org-garage-guard"
    try:
        with urllib.request.build_opener(RejectRedirect()).open(
            urllib.request.Request(url, headers=headers), timeout=15
        ) as response:
            if response.status != 200:
                raise Blocked("API unavailable")
            raw = response.read(MAX + 1)
            if len(raw) > MAX:
                raise Blocked("API response oversized")
            return json.loads(raw), {k.lower(): v for k, v in response.headers.items()}
    except (OSError, ValueError, urllib.error.URLError):
        raise Blocked("API check unavailable") from None

def verify(gh_token, gl_token, sha, fetch=request):
    if not gh_token or not gl_token or not isinstance(sha, str) or not re.fullmatch("[0-9a-f]{40}", sha):
        raise Blocked("identity or credential missing")
    src, _ = fetch(GH, gh_token, "github")
    if not isinstance(src, dict) or src.get("full_name") != SOURCE or src.get("private") is not True or src.get("visibility") != "private" or src.get("default_branch") != "main":
        raise Blocked("source identity/privacy")
    ref, _ = fetch(GH + "/git/ref/heads/main", gh_token, "github")
    if not isinstance(ref, dict) or ref.get("ref") != "refs/heads/main" or not isinstance(ref.get("object"), dict) or ref["object"].get("type") != "commit" or ref["object"].get("sha") != sha:
        raise Blocked("source ref changed")
    project, _ = fetch(GL, gl_token, "gitlab")
    if not isinstance(project, dict) or type(project.get("id")) is not int or project["id"] != TARGET_ID or project.get("path_with_namespace") != TARGET_PATH or project.get("http_url_to_repo") != TARGET_URL or project.get("visibility") != "private" or project.get("shared_with_groups") != []:
        raise Blocked("target identity/privacy/sharing")
    members, headers = fetch(GL + "/members/all?per_page=100", gl_token, "gitlab")
    # A full page, next link, pagination inconsistency or unavailable member data is not approval.
    next_page = headers.get("x-next-page", "")
    total = headers.get("x-total")
    pages = headers.get("x-total-pages")
    if next_page or 'rel="next"' in headers.get("link", "").lower() or (total is not None and total != "1") or (pages is not None and pages != "1") or not isinstance(members, list) or len(members) != 1:
        raise Blocked("unverified target membership")
    member = members[0]
    if not isinstance(member, dict) or member.get("username") != OWNER or type(member.get("access_level")) is not int or member["access_level"] != 50 or member.get("state") != "active":
        raise Blocked("target membership not approved")
    branch, _ = fetch(GL + "/repository/branches/main", gl_token, "gitlab")
    if not isinstance(branch, dict) or branch.get("name") != "main" or not isinstance(branch.get("commit"), dict):
        raise Blocked("target ref unavailable")
    target_sha = branch["commit"].get("id")
    if not isinstance(target_sha, str) or not re.fullmatch("[0-9a-f]{40}", target_sha):
        raise Blocked("invalid target ref")
    return target_sha

def push_exact(sha, token):
    # Fresh hosted checkout only. No global/system Git config, hooks, redirects,
    # wildcard refs, force, tags, mirror/prune or deletion. No token in argv/logs.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.pop("GITHUB_TOKEN", None)
    env.pop("GITLAB_TOKEN", None)
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_TERMINAL_PROMPT="0", GARAGE_GITLAB_AUTH="Authorization: Basic " +
               base64.b64encode(("oauth2:" + token).encode()).decode())
    args = ["git", "-c", "credential.helper=", "-c", "http.followRedirects=false",
            "-c", "core.hooksPath=/dev/null", "--config-env=http.extraHeader=GARAGE_GITLAB_AUTH",
            "push", "--atomic", "--no-follow-tags", TARGET_URL, sha + ":refs/heads/main"]
    try:
        result = subprocess.run(args, env=env, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("push uncertain; reconcile before retry") from None
    if result.returncode:
        raise Blocked("push rejected or uncertain; reconcile before retry")

def guarded_sync(gh_token, gl_token, sha, fetch=request, push=push_exact):
    target_sha = verify(gh_token, gl_token, sha, fetch)
    if target_sha != sha:
        push(sha, gl_token)
    # Reconcile the actual target ref even after an acknowledged push.
    if verify(gh_token, gl_token, sha, fetch) != sha:
        raise Blocked("target ref not confirmed")

def main():
    if os.environ.get("GITHUB_REPOSITORY") != SOURCE or os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise Blocked("wrong workflow repository or ref")
    sha = os.environ.get("GITHUB_SHA", "")
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True, timeout=10).stdout.strip()
    if head != sha:
        raise Blocked("checkout mismatch")
    guarded_sync(os.environ.get("GITHUB_TOKEN"), os.environ.get("GITLAB_TOKEN"), sha)

if __name__ == "__main__":
    try:
        main()
        print("Approved private destination; exact main ref synchronized and rechecked")
    except (Blocked, subprocess.SubprocessError, OSError):
        # Do not print exception internals, provider bodies or credential-bearing URLs.
        print("Garage mirror blocked or uncertain; inspect metadata and reconcile before retry")
        raise SystemExit(1)
