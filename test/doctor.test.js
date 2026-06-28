import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runDoctor } from "../src/agents/doctor.js";

test("runDoctor reports readiness without exposing provider secrets", () => {
  const result = runDoctor({
    root: process.cwd(),
    env: {
      VIBEGUARD_LLM_PROVIDER: "grok",
      XAI_API_KEY: "secret-value",
      GITHUB_TOKEN: "github-secret",
      VIBEGUARD_MODEL: "grok-test",
      VIBEGUARD_HTTPS_PROXY: "http://127.0.0.1:10809"
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider.provider, "grok");
  assert.equal(result.provider.hasGrokKey, true);
  assert.equal(result.provider.model, "grok-test");
  assert.equal(result.provider.ready, true);
  assert.equal(result.githubAuth.hasToken, true);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(JSON.stringify(result).includes("github-secret"), false);
});

test("runDoctor reports the Grok default model when no model is configured", () => {
  const result = runDoctor({
    root: process.cwd(),
    env: {
      XAI_API_KEY: "secret-value"
    }
  });

  assert.equal(result.provider.provider, "grok");
  assert.equal(result.provider.model, "grok-4.3");
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
});

test("runDoctor reports final capability readiness", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-doctor-readiness-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });

  const result = runDoctor({
    root,
    env: {
      VIBEGUARD_LLM_PROVIDER: "grok",
      XAI_API_KEY: "secret-value",
      GITHUB_TOKEN: "github-secret"
    },
    toolStatus: {
      git: { available: true, detail: "git version test" },
      gh: { available: false, detail: "missing" }
    }
  });
  const readiness = new Map(result.capabilityReadiness.capabilities.map((item) => [item.id, item]));

  assert.equal(result.capabilityReadiness.status, "ready");
  assert.equal(result.capabilityReadiness.counts.ready, 7);
  assert.equal(readiness.get("policy_as_code").ready, true);
  assert.equal(readiness.get("ai_debug_agent").ready, true);
  assert.equal(readiness.get("repo_onboarding_agent").ready, true);
  assert.equal(readiness.get("test_writer_agent").ready, true);
  assert.equal(readiness.get("pr_review_agent").ready, true);
  assert.equal(readiness.get("codex_grok_integration").provider, "grok");
  assert.equal(readiness.get("github_pr_loop").hasToken, true);
  assert.equal(readiness.get("github_pr_loop").hasGh, false);
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(JSON.stringify(result).includes("github-secret"), false);
});

test("runDoctor returns next actions for missing provider and GitHub execution auth", () => {
  const result = runDoctor({
    root: process.cwd(),
    env: {},
    toolStatus: {
      git: { available: true, detail: "git version test" },
      gh: { available: false, detail: "missing" }
    }
  });

  assert.equal(result.provider.ready, false);
  assert.deepEqual(result.nextActions.map((action) => action.id), [
    "configure_ai_provider",
    "enable_github_execution"
  ]);
  assert.match(result.nextActions[0].command, /XAI_API_KEY|GROK_API_KEY/);
  assert.match(result.nextActions[1].reason, /PR\/comment\/review-comment writes/);
  assert.doesNotMatch(result.nextActions[1].reason, /check execution/);
});

test("runDoctor honors policy before detecting GitHub remotes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-doctor-github-policy-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny:
    - "git remote get-url origin"
  require_confirmation: []
`, "utf8");

  const result = runDoctor({
    root,
    env: { XAI_API_KEY: "secret-value" },
    toolStatus: {
      git: { available: true, detail: "git version test" },
      gh: { available: true, detail: "gh version test" }
    }
  });

  assert.equal(result.github.status, "unavailable");
  assert.match(result.github.error, /Command matches deny policy: git remote get-url origin/);
});

test("runDoctor honors policy before probing local tools", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-doctor-tool-policy-"));
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny:
    - "git --version"
  require_confirmation: []
`, "utf8");

  const result = runDoctor({
    root,
    env: { XAI_API_KEY: "secret-value" }
  });

  assert.equal(result.tools.git.available, false);
  assert.equal(result.tools.git.command, "git --version");
  assert.match(result.tools.git.detail, /Command matches deny policy: git --version/);
});
