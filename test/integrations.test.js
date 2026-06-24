import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hookTemplate, listHooks } from "../src/integrations/hooks.js";
import { buildGhPrArgs, buildGhPrCommentArgs, buildGhRunListArgs, commentPullRequestWithGh, createPullRequestWithGh, listWorkflowRunsWithGh, parseGitHubRemote } from "../src/integrations/github.js";
import { buildFixGitPlan, checkGitPlanPolicy, executeGitPlan } from "../src/integrations/gitPlan.js";
import { buildPrSummary, writePrSummaryBody } from "../src/agents/pr.js";
import { generateDebugPatch } from "../src/llm/provider.js";
import { PolicyEngine } from "../src/policy/engine.js";

const bin = path.resolve("bin/vibeguard.js");

function tempGitHubRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-github-api-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  return root;
}

test("hook templates include pre-commit policy check", () => {
  assert.ok(listHooks().includes("pre-commit"));
  assert.match(hookTemplate("pre-commit"), /policy check/);
});

test("buildPrSummary returns GitHub-ready body", () => {
  const diff = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;
  const result = buildPrSummary(diff);
  assert.match(result.body, /Changed Files/);
  assert.match(result.body, /src\/app.js/);
  assert.match(result.body, /Review Action Items/);
  assert.match(result.body, /Findings by severity/);
  assert.match(result.body, /Add or update a focused test/);
  assert.equal(result.review.files[0], "src/app.js");
});

test("writePrSummaryBody writes a GitHub-ready body through policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-pr-body-"));
  const engine = new PolicyEngine({
    paths: { allow: ["reports/**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });
  const diff = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;

  const result = writePrSummaryBody(root, diff, "reports/pr-body.md", engine);

  assert.equal(result.writtenBody.path, "reports/pr-body.md");
  assert.equal(result.writtenBody.policy.status, "allow");
  assert.match(fs.readFileSync(path.join(root, "reports", "pr-body.md"), "utf8"), /Review Action Items/);
});

test("generateDebugPatch is unavailable without provider env", async () => {
  const result = await generateDebugPatch({ summary: { type: "Error" } }, {});
  assert.equal(result.status, "unavailable");
});

test("generateDebugPatch fixture provider returns local patch text", async () => {
  const result = await generateDebugPatch({ summary: { type: "Error" } }, {
    VIBEGUARD_LLM_PROVIDER: "fixture",
    VIBEGUARD_FIXTURE_PATCH: "not a diff"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.patch, "not a diff");
});

test("generateDebugPatch uses Grok-compatible Responses API", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (endpoint, options) => {
    request = {
      endpoint,
      headers: options.headers,
      body: JSON.parse(options.body)
    };
    return {
      ok: true,
      async json() {
        return { output_text: "diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n" };
      }
    };
  };

  try {
    const result = await generateDebugPatch({ summary: { type: "ReferenceError" } }, {
      XAI_API_KEY: "xai-secret",
      VIBEGUARD_MODEL: "grok-test"
    });

    assert.equal(result.status, "ok");
    assert.equal(request.endpoint, "https://api.x.ai/v1/responses");
    assert.equal(request.headers.authorization, "Bearer xai-secret");
    assert.equal(request.body.model, "grok-test");
    assert.match(request.body.input[0].content, /unified diff/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generateDebugPatch summarizes provider HTTP error bodies without secrets", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    async text() {
      return JSON.stringify({ error: { message: "Unsupported model: grok-old" } });
    }
  });

  try {
    const result = await generateDebugPatch({ summary: { type: "ReferenceError" } }, {
      XAI_API_KEY: "xai-secret",
      VIBEGUARD_MODEL: "grok-old"
    });

    assert.equal(result.status, "error");
    assert.match(result.reason, /HTTP 400: Unsupported model: grok-old/);
    assert.equal(result.reason.includes("xai-secret"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("parseGitHubRemote supports https and ssh remotes", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/patrick892368/VibeGuard-AI-Dev-Agent.git"), {
    owner: "patrick892368",
    repo: "VibeGuard-AI-Dev-Agent",
    url: "https://github.com/patrick892368/VibeGuard-AI-Dev-Agent"
  });
  assert.deepEqual(parseGitHubRemote("git@github.com:owner/repo.git"), {
    owner: "owner",
    repo: "repo",
    url: "https://github.com/owner/repo"
  });
});

test("GitHub PR creation is dry-run by default", async () => {
  assert.deepEqual(buildGhPrArgs({ title: "Fix bug", bodyFile: "pr.md", draft: true }), [
    "pr",
    "create",
    "--title",
    "Fix bug",
    "--body-file",
    "pr.md",
    "--draft"
  ]);
  const result = await createPullRequestWithGh(process.cwd(), { title: "Fix bug" });
  assert.equal(result.status, "dry_run");
  assert.match(result.command, /gh pr create/);
});

test("GitHub PR creation can use REST API fallback", async () => {
  const root = tempGitHubRepo();
  let request;
  const result = await createPullRequestWithGh(root, {
    title: "Fix bug",
    body: "body",
    base: "main",
    head: "codex/fix-bug",
    draft: true,
    dryRun: false,
    useApi: true,
    env: { GITHUB_TOKEN: "token" },
    async fetch(url, options) {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        async json() {
          return { html_url: "https://github.com/owner/repo/pull/1", number: 1 };
        }
      };
    }
  });

  assert.equal(result.status, "created");
  assert.equal(result.method, "api");
  assert.equal(result.url, "https://github.com/owner/repo/pull/1");
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/pulls");
  assert.equal(request.options.headers.authorization, "Bearer token");
  assert.deepEqual(request.body, {
    title: "Fix bug",
    body: "body",
    base: "main",
    head: "codex/fix-bug",
    draft: true
  });
});

test("GitHub PR comments are dry-run by default", async () => {
  assert.deepEqual(buildGhPrCommentArgs({ pr: 12, bodyFile: "review.md" }), [
    "pr",
    "comment",
    "12",
    "--body-file",
    "review.md"
  ]);
  const result = await commentPullRequestWithGh(process.cwd(), { pr: 12, body: "Looks good" });
  assert.equal(result.status, "dry_run");
  assert.match(result.command, /gh pr comment 12/);
});

test("GitHub PR comments can use REST API fallback", async () => {
  const root = tempGitHubRepo();
  let request;
  const result = await commentPullRequestWithGh(root, {
    pr: 12,
    body: "review",
    dryRun: false,
    useApi: true,
    env: { GITHUB_TOKEN: "token" },
    async fetch(url, options) {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        async json() {
          return { html_url: "https://github.com/owner/repo/pull/1#issuecomment-1", id: 1 };
        }
      };
    }
  });

  assert.equal(result.status, "commented");
  assert.equal(result.method, "api");
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/issues/12/comments");
  assert.deepEqual(request.body, { body: "review" });
});

test("CLI GitHub PR comment execute requires command confirmation", () => {
  const output = execFileSync(process.execPath, [bin, "github", "comment", "--pr", "12", "--body", "review", "--execute", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const result = JSON.parse(output);
  assert.equal(result.status, "require_confirmation");
  assert.equal(result.stage, "github_comment_policy");
  assert.match(result.command, /gh pr comment 12/);
});

test("GitHub checks are dry-run by default", async () => {
  assert.deepEqual(buildGhRunListArgs({ branch: "codex/fix-bug", limit: 5 }), [
    "run",
    "list",
    "--limit",
    "5",
    "--json",
    "databaseId,status,conclusion,name,headBranch,event,workflowName,url,createdAt,updatedAt",
    "--branch",
    "codex/fix-bug"
  ]);
  const result = await listWorkflowRunsWithGh(process.cwd(), { branch: "codex/fix-bug" });
  assert.equal(result.status, "dry_run");
  assert.match(result.command, /gh run list/);
});

test("GitHub checks can use REST API fallback", async () => {
  const root = tempGitHubRepo();
  let requestUrl;
  const result = await listWorkflowRunsWithGh(root, {
    branch: "codex/fix-bug",
    limit: 5,
    dryRun: false,
    useApi: true,
    env: { GITHUB_TOKEN: "token" },
    async fetch(url) {
      requestUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            workflow_runs: [{
              id: 123,
              status: "completed",
              conclusion: "success",
              name: "CI",
              head_branch: "codex/fix-bug",
              event: "pull_request",
              workflow_name: "CI",
              html_url: "https://github.com/owner/repo/actions/runs/123",
              created_at: "2026-06-24T00:00:00Z",
              updated_at: "2026-06-24T00:01:00Z"
            }]
          };
        }
      };
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.method, "api");
  assert.match(requestUrl, /\/repos\/owner\/repo\/actions\/runs\?per_page=5&branch=codex%2Ffix-bug$/);
  assert.deepEqual(result.runs[0], {
    databaseId: 123,
    status: "completed",
    conclusion: "success",
    name: "CI",
    headBranch: "codex/fix-bug",
    event: "pull_request",
    workflowName: "CI",
    url: "https://github.com/owner/repo/actions/runs/123",
    createdAt: "2026-06-24T00:00:00Z",
    updatedAt: "2026-06-24T00:01:00Z"
  });
});

test("buildFixGitPlan includes push and PR commands for Codex review", () => {
  const plan = buildFixGitPlan({
    patch: `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`,
    branch: "codex/fix-error",
    commitMessage: "fix: error",
    title: "Fix error",
    body: "body",
    createBranch: true,
    commit: true,
    push: true,
    prDryRun: true
  });

  assert.deepEqual(plan.commands.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "push_branch",
    "create_pr"
  ]);
  assert.match(plan.commands.find((command) => command.step === "push_branch").command, /git push -u origin codex\/fix-error/);
});

test("checkGitPlanPolicy requires confirmation for external git and PR actions", () => {
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: {
      deny: [],
      require_confirmation: ["git switch -c", "git commit", "git push", "gh pr create"]
    }
  });
  const plan = buildFixGitPlan({
    changedFiles: ["src/app.js"],
    branch: "codex/fix-error",
    commitMessage: "fix: error",
    title: "Fix error",
    body: "body",
    createBranch: true,
    commit: true,
    push: true,
    prDryRun: true
  });

  assert.equal(checkGitPlanPolicy(plan, engine).status, "require_confirmation");
  assert.equal(checkGitPlanPolicy(plan, engine, { confirmed: true }).status, "allow");
});

test("executeGitPlan dispatches create_pr through the protected command runner", () => {
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: {
      deny: [],
      require_confirmation: ["gh pr create"]
    }
  });
  const plan = buildFixGitPlan({
    changedFiles: ["src/app.js"],
    branch: "codex/fix-error",
    commitMessage: "fix: error",
    title: "Fix error",
    bodyFile: "fixes/pr-body.md",
    prDryRun: true
  });
  const calls = [];
  const result = executeGitPlan(process.cwd(), plan, engine, {
    confirmed: true,
    runArgvWithPolicy(root, argv, policyEngine, options) {
      calls.push({ root, argv, status: policyEngine.checkCommand(argv.join(" ")).status, confirmed: options.confirmed });
      return {
        status: "passed",
        exitCode: 0,
        command: argv.join(" "),
        argv,
        stdout: "https://example.com/pull/1\n",
        stderr: "",
        policy: policyEngine.checkCommand(argv.join(" "))
      };
    }
  });

  assert.equal(result.status, "executed");
  assert.equal(result.results[0].step, "create_pr");
  assert.equal(calls[0].argv[0], "gh");
  assert.deepEqual(calls[0].argv.slice(0, 3), ["gh", "pr", "create"]);
  assert.equal(calls[0].confirmed, true);
});
