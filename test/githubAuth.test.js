import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectGithubAuth } from "../src/integrations/githubAuth.js";

function tempGitHubRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-github-auth-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  return root;
}

test("inspectGithubAuth reports token write readiness without exposing secrets", () => {
  const root = tempGitHubRepo();
  const result = inspectGithubAuth({
    root,
    env: {
      GITHUB_TOKEN: "github-secret"
    },
    toolStatus: {
      gh: { available: false, detail: "missing" }
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.github.status, "detected");
  assert.equal(result.githubAuth.hasToken, true);
  assert.equal(result.githubAuth.canWrite, true);
  assert.deepEqual(result.githubAuth.tokenSources, [
    { name: "GITHUB_TOKEN", present: true },
    { name: "GH_TOKEN", present: false }
  ]);
  assert.equal(result.nextActions.some((action) => action.id === "enable_github_execution"), false);
  assert.equal(JSON.stringify(result).includes("github-secret"), false);
});

test("inspectGithubAuth accepts authenticated gh as write-ready without a token", () => {
  const root = tempGitHubRepo();
  const result = inspectGithubAuth({
    root,
    env: {},
    toolStatus: {
      gh: { available: true, detail: "gh version test" }
    },
    ghAuthStatus: {
      available: true,
      authenticated: true,
      command: "gh auth status",
      detail: "Logged in to github.com"
    }
  });

  assert.equal(result.githubAuth.hasToken, false);
  assert.equal(result.githubAuth.gh.authenticated, true);
  assert.equal(result.githubAuth.canWrite, true);
  assert.equal(result.nextActions.some((action) => action.id === "enable_github_execution"), false);
});

test("inspectGithubAuth reports a policy-blocked gh auth probe", () => {
  const root = tempGitHubRepo();
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny:
    - "gh auth status"
  require_confirmation: []
`, "utf8");

  const result = inspectGithubAuth({
    root,
    env: {},
    toolStatus: {
      gh: { available: true, detail: "gh version test" }
    }
  });

  assert.equal(result.githubAuth.canWrite, false);
  assert.equal(result.githubAuth.gh.authenticated, false);
  assert.match(result.githubAuth.gh.detail, /Command matches deny policy: gh auth status/);
  assert.equal(result.nextActions.some((action) => action.id === "enable_github_execution"), true);
});
