import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hookTemplate, installHook, listHooks } from "../src/integrations/hooks.js";
import { buildGhPrArgs, buildGhPrCommentArgs, buildGhPrDiffArgs, buildGhPrReviewCommentArgs, buildGhRunListArgs, checkGitHubCommandsPolicy, commentPullRequestWithGh, createPullRequestWithGh, createReviewCommentWithGh, createReviewCommentsWithGh, detectGitHubRepository, getPullRequestDiffWithGh, listWorkflowRunsWithGh, parseGitHubRemote, summarizeWorkflowRuns } from "../src/integrations/github.js";
import { buildFixGitPlan, checkGitPlanPolicy, executeGitPlan, executeGitPlanAsync } from "../src/integrations/gitPlan.js";
import { buildPrSummary, writePrSummaryBody } from "../src/agents/pr.js";
import { buildDebugRepairPlan, generateDebugPatch } from "../src/llm/provider.js";
import { PolicyEngine } from "../src/policy/engine.js";

const bin = path.resolve("bin/vibeguard.js");

function tempGitHubRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-github-api-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  return root;
}

function permissivePolicyEngine(root) {
  return new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });
}

test("hook templates include pre-commit policy check", () => {
  assert.ok(listHooks().includes("pre-commit"));
  assert.match(hookTemplate("pre-commit"), /policy check/);
});

test("installHook requires explicit Git directory confirmation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-hook-confirm-"));
  const result = installHook(root, "pre-commit");

  assert.equal(result.status, "require_confirmation");
  assert.equal(result.stage, "hook_install_git_dir_confirmation");
  assert.equal(result.path, ".git/hooks/pre-commit");
});

test("installHook checks .git hook paths through policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-hook-policy-"));
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [".git/**"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const result = installHook(root, "pre-commit", { allowGitDir: true, engine });

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "hook_install_policy");
  assert.equal(result.policy.path, ".git/hooks/pre-commit");
});

test("installHook writes hooks only after policy allows the target path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-hook-install-"));
  const engine = new PolicyEngine({
    paths: { allow: [".git/hooks/**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const result = installHook(root, "pre-commit", { allowGitDir: true, engine });

  assert.equal(result.status, "installed");
  assert.equal(result.policy.status, "allow");
  assert.match(fs.readFileSync(path.join(root, ".git", "hooks", "pre-commit"), "utf8"), /policy check/);
});

test("public API exports GitHub batch review helpers", async () => {
  const api = await import("../src/index.js");

  assert.equal(typeof api.buildDebugRepairPlan, "function");
  assert.equal(typeof api.publishReviewComment, "function");
  assert.equal(typeof api.createReviewCommentsWithGh, "function");
  assert.equal(typeof api.checkGitHubCommandsPolicy, "function");
  assert.equal(typeof api.buildGhPrDiffArgs, "function");
  assert.equal(typeof api.getPullRequestDiffWithGh, "function");
  assert.equal(typeof api.checkGitPlanPolicy, "function");
  assert.equal(typeof api.executeGitPlan, "function");
  assert.equal(typeof api.executeGitPlanAsync, "function");
  assert.equal(typeof api.writeSuggestedTests, "function");
  assert.equal(typeof api.writeSuggestedTestsAsync, "function");
  assert.equal(typeof api.compareCoverageReports, "function");
  assert.equal(typeof api.summarizeWorkflowRuns, "function");
  assert.equal(api.GITHUB_DETECT_COMMAND, "git remote get-url origin");
  assert.equal(api.GITHUB_CURRENT_BRANCH_COMMAND, "git branch --show-current");
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
  assert.equal(result.repairPlan.status, "suggested");
});

test("generateDebugPatch fixture provider returns local patch text", async () => {
  const result = await generateDebugPatch({
    summary: { type: "Error" },
    frames: [{ file: "src/app.js", line: 10, symbol: "main" }]
  }, {
    VIBEGUARD_LLM_PROVIDER: "fixture",
    VIBEGUARD_FIXTURE_PATCH: "not a diff"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.patch, "not a diff");
  assert.equal(result.repairPlan.primaryFile, "src/app.js");
  assert.match(result.repairPlan.steps[0], /src\/app\.js:10/);
});

test("generateDebugPatch fixture patch files are path-policy gated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-provider-policy-"));
  fs.writeFileSync(path.join(root, ".env"), "diff --git a/src/app.js b/src/app.js\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const result = await generateDebugPatch({ summary: { type: "Error" } }, {
    VIBEGUARD_LLM_PROVIDER: "fixture",
    VIBEGUARD_FIXTURE_PATCH_FILE: ".env"
  }, {
    root,
    engine
  });

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "fixture_patch_file_policy");
  assert.equal(result.patchFileRead.path, ".env");
  assert.equal(result.patchFileRead.policy.status, "deny");
  assert.equal(result.patch, undefined);
});

test("buildDebugRepairPlan returns a structured repair strategy", () => {
  const plan = buildDebugRepairPlan({
    summary: { type: "TemplateDoesNotExist", message: "accounts/detail.html" },
    explanation: { likelyCause: "The view points at a template path that does not exist." },
    frames: [{ file: "accounts/views.py", line: 7, symbol: "detail" }],
    likelyFiles: ["accounts/views.py", "templates/accounts/detail.html"],
    frameworkContext: { framework: "Django", likelyFiles: ["project/settings.py"] },
    suggestedTestCommands: ["python manage.py test accounts"]
  });

  assert.equal(plan.status, "suggested");
  assert.equal(plan.errorType, "TemplateDoesNotExist");
  assert.equal(plan.framework, "Django");
  assert.equal(plan.primaryFile, "accounts/views.py");
  assert.deepEqual(plan.targetFiles.slice(0, 3), ["accounts/views.py", "templates/accounts/detail.html", "project/settings.py"]);
  assert.match(plan.strategy, /Django render\/template reference/);
  assert.deepEqual(plan.validation.testCommands, ["python manage.py test accounts"]);
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
    assert.equal(result.repairPlan.errorType, "ReferenceError");
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

test("GitHub detection honors direct helper prerequisite command policy", () => {
  const root = tempGitHubRepo();
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: ["git remote get-url origin"], require_confirmation: [] }
  }, { root });

  assert.throws(() => detectGitHubRepository(root, { engine }), /Command matches deny policy: git remote get-url origin/);
});

test("GitHub detection helpers require a policy engine", () => {
  const root = tempGitHubRepo();

  assert.throws(() => detectGitHubRepository(root), /GitHub detection requires a PolicyEngine/);
});

test("GitHub detection succeeds with an allowed policy engine", () => {
  const root = tempGitHubRepo();
  const result = detectGitHubRepository(root, { engine: permissivePolicyEngine(root) });

  assert.equal(result.owner, "owner");
  assert.equal(result.repo, "repo");
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
    engine: permissivePolicyEngine(root),
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

test("GitHub PR diff can use REST API fallback", async () => {
  const root = tempGitHubRepo();
  let request;
  const diff = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1,2 @@
 old
+new
`;

  const result = await getPullRequestDiffWithGh(root, {
    pr: 12,
    dryRun: false,
    useApi: true,
    engine: permissivePolicyEngine(root),
    env: { GITHUB_TOKEN: "token" },
    async fetch(url, options) {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async text() {
          return diff;
        }
      };
    }
  });

  assert.equal(result.status, "fetched");
  assert.equal(result.method, "api");
  assert.equal(result.pr, 12);
  assert.equal(result.diff, diff);
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/pulls/12");
  assert.equal(request.options.headers.accept, "application/vnd.github.v3.diff");
});

test("GitHub REST API PR execution honors direct helper command policy", async () => {
  const root = tempGitHubRepo();
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: ["gh pr create"] }
  }, { root });

  await assert.rejects(() => createPullRequestWithGh(root, {
    title: "Fix bug",
    body: "body",
    head: "codex/fix-bug",
    dryRun: false,
    useApi: true,
    engine,
    env: { GITHUB_TOKEN: "token" },
    async fetch() {
      throw new Error("fetch should not be called");
    }
  }), /Command requires human confirmation: gh pr create/);
});

test("GitHub REST API PR execution checks current-branch prerequisite policy", async () => {
  const root = tempGitHubRepo();
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: ["git branch --show-current"] }
  }, { root });

  await assert.rejects(() => createPullRequestWithGh(root, {
    title: "Fix bug",
    body: "body",
    dryRun: false,
    useApi: true,
    engine,
    env: { GITHUB_TOKEN: "token" },
    async fetch() {
      throw new Error("fetch should not be called");
    }
  }), /Command requires human confirmation: git branch --show-current/);
});

test("GitHub REST API body files cannot escape the repository root", async () => {
  const root = tempGitHubRepo();
  const outside = path.join(os.tmpdir(), `vibeguard-outside-${Date.now()}.md`);
  fs.writeFileSync(outside, "body", "utf8");

  await assert.rejects(() => createPullRequestWithGh(root, {
    title: "Fix bug",
    bodyFile: outside,
    dryRun: false,
    useApi: true,
    engine: permissivePolicyEngine(root),
    env: { GITHUB_TOKEN: "token" },
    async fetch() {
      throw new Error("fetch should not be called");
    }
  }), /Path escapes repository root/);
});

test("GitHub REST API body files honor direct helper path policy", async () => {
  const root = tempGitHubRepo();
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  await assert.rejects(() => createPullRequestWithGh(root, {
    title: "Fix bug",
    bodyFile: ".env",
    dryRun: false,
    useApi: true,
    engine,
    env: { GITHUB_TOKEN: "token" },
    async fetch() {
      throw new Error("fetch should not be called");
    }
  }), /Path matches deny policy: \.env/);
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
    engine: permissivePolicyEngine(root),
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

test("GitHub execution helpers require a policy engine", async () => {
  const root = tempGitHubRepo();

  await assert.rejects(() => commentPullRequestWithGh(root, {
    pr: 12,
    body: "review",
    dryRun: false,
    useApi: true,
    env: { GITHUB_TOKEN: "token" },
    async fetch() {
      throw new Error("fetch should not be called");
    }
  }), /GitHub PR comment requires a PolicyEngine/);
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

test("CLI GitHub PR blocks denied body files before dry-run", () => {
  const root = tempGitHubRepo();
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");

  let output;
  try {
    output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "github",
      "pr",
      "--title",
      "Fix bug",
      "--body-file",
      ".env",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
  } catch (error) {
    output = error.stdout;
  }
  const result = JSON.parse(output);

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "github_pr_body_file_policy");
  assert.equal(result.policy.path, ".env");
});

test("GitHub PR review comments are dry-run by default", async () => {
  assert.deepEqual(buildGhPrReviewCommentArgs({
    pr: 12,
    bodyFile: "review.md",
    commitId: "abc123",
    path: "src/app.js",
    line: 10
  }), [
    "api",
    "repos/{owner}/{repo}/pulls/12/comments",
    "--method",
    "POST",
    "--field",
    "body=@review.md",
    "--field",
    "commit_id=abc123",
    "--field",
    "path=src/app.js",
    "--field",
    "line=10",
    "--field",
    "side=RIGHT"
  ]);
  const result = await createReviewCommentWithGh(process.cwd(), {
    pr: 12,
    body: "review",
    commitId: "abc123",
    path: "src/app.js",
    line: 10
  });
  assert.equal(result.status, "dry_run");
  assert.match(result.command, /gh api repos\/\{owner\}\/\{repo\}\/pulls\/12\/comments/);
});

test("GitHub PR review comments can use REST API fallback", async () => {
  const root = tempGitHubRepo();
  let request;
  const result = await createReviewCommentWithGh(root, {
    pr: 12,
    body: "review",
    commitId: "abc123",
    path: "src/app.js",
    line: 10,
    dryRun: false,
    useApi: true,
    engine: permissivePolicyEngine(root),
    env: { GITHUB_TOKEN: "token" },
    async fetch(url, options) {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        async json() {
          return { html_url: "https://github.com/owner/repo/pull/1#discussion_r1", id: 1 };
        }
      };
    }
  });

  assert.equal(result.status, "review_commented");
  assert.equal(result.method, "api");
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/pulls/12/comments");
  assert.deepEqual(request.body, {
    body: "review",
    commit_id: "abc123",
    path: "src/app.js",
    line: 10,
    side: "RIGHT"
  });
});

test("GitHub PR review comments can be published as a policy-checkable batch dry-run", async () => {
  const result = await createReviewCommentsWithGh(process.cwd(), {
    pr: 12,
    commitId: "abc123",
    comments: [
      {
        path: "src/app.js",
        line: 10,
        side: "RIGHT",
        severity: "high",
        category: "security",
        body: "Fix this issue"
      },
      {
        path: "src/db.js",
        line: 4,
        severity: "medium",
        category: "testing",
        body: "Add a focused test"
      }
    ],
    limit: 1
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.count, 1);
  assert.equal(result.totalReviewComments, 2);
  assert.equal(result.skipped, 1);
  assert.match(result.comments[0].command, /gh api repos\/\{owner\}\/\{repo\}\/pulls\/12\/comments/);

  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: ["gh api"] }
  });
  assert.equal(checkGitHubCommandsPolicy(result.comments, engine, {
    stage: "github_review_comments_policy"
  }).status, "require_confirmation");
  assert.equal(checkGitHubCommandsPolicy(result.comments, engine, {
    stage: "github_review_comments_policy",
    confirmed: true
  }).status, "allow");
});

test("GitHub PR review comment batches can use REST API fallback", async () => {
  const root = tempGitHubRepo();
  const requests = [];
  const result = await createReviewCommentsWithGh(root, {
    pr: 12,
    commitId: "abc123",
    comments: [
      { path: "src/app.js", line: 10, body: "First review" },
      { path: "src/db.js", line: 4, body: "Second review" }
    ],
    dryRun: false,
    useApi: true,
    engine: permissivePolicyEngine(root),
    env: { GITHUB_TOKEN: "token" },
    async fetch(url, options) {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 201,
        async json() {
          return { html_url: `https://github.com/owner/repo/pull/1#discussion_r${requests.length}`, id: requests.length };
        }
      };
    }
  });

  assert.equal(result.status, "review_comments_published");
  assert.equal(result.count, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.github.com/repos/owner/repo/pulls/12/comments");
  assert.deepEqual(requests[0].body, {
    body: "First review",
    commit_id: "abc123",
    path: "src/app.js",
    line: 10,
    side: "RIGHT"
  });
});

test("CLI GitHub PR review comment execute requires command confirmation", () => {
  const output = execFileSync(process.execPath, [
    bin,
    "github",
    "review-comment",
    "--pr",
    "12",
    "--body",
    "review",
    "--commit",
    "abc123",
    "--path",
    "src/app.js",
    "--line",
    "10",
    "--execute",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const result = JSON.parse(output);
  assert.equal(result.status, "require_confirmation");
  assert.equal(result.stage, "github_review_comment_policy");
  assert.match(result.command, /gh api repos\/\{owner\}\/\{repo\}\/pulls\/12\/comments/);
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

test("GitHub workflow run summary produces a CI gate decision", () => {
  const passing = summarizeWorkflowRuns([
    { databaseId: 1, status: "completed", conclusion: "success", name: "CI" },
    { databaseId: 2, status: "completed", conclusion: "skipped", name: "Docs" }
  ]);
  const failing = summarizeWorkflowRuns([
    { databaseId: 3, status: "completed", conclusion: "failure", name: "CI", url: "https://example.com/run/3" },
    { databaseId: 4, status: "in_progress", conclusion: null, name: "Lint" }
  ]);
  const pending = summarizeWorkflowRuns([
    { databaseId: 5, status: "queued", conclusion: null, name: "CI" }
  ]);

  assert.equal(passing.status, "passing");
  assert.equal(passing.gate, "pass");
  assert.equal(failing.status, "failing");
  assert.equal(failing.gate, "fail");
  assert.equal(failing.failingRuns[0].name, "CI");
  assert.equal(pending.status, "pending");
  assert.equal(pending.gate, "wait");
  assert.equal(summarizeWorkflowRuns([]).status, "no_runs");
});

test("GitHub checks can use REST API fallback", async () => {
  const root = tempGitHubRepo();
  let requestUrl;
  const result = await listWorkflowRunsWithGh(root, {
    branch: "codex/fix-bug",
    limit: 5,
    dryRun: false,
    useApi: true,
    engine: permissivePolicyEngine(root),
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
  assert.equal(result.summary.status, "passing");
  assert.equal(result.summary.gate, "pass");
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

test("checkGitPlanPolicy blocks denied PR body files", () => {
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  });
  const plan = buildFixGitPlan({
    changedFiles: ["src/app.js"],
    branch: "codex/fix-error",
    commitMessage: "fix: error",
    title: "Fix error",
    bodyFile: ".env",
    prDryRun: true
  });

  const policy = checkGitPlanPolicy(plan, engine);

  assert.equal(policy.status, "deny");
  assert.equal(policy.pathResults[0].path, ".env");
  assert.equal(policy.pathResults[0].policy.operation, "read_pr_body");
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

test("executeGitPlanAsync can create PRs through the REST fallback", async () => {
  const root = tempGitHubRepo();
  const engine = permissivePolicyEngine(root);
  const plan = buildFixGitPlan({
    changedFiles: ["src/app.js"],
    branch: "codex/fix-error",
    commitMessage: "fix: error",
    title: "Fix error",
    body: "body",
    prDryRun: true
  });
  let request;

  const result = await executeGitPlanAsync(root, plan, engine, {
    confirmed: true,
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

  assert.equal(result.status, "executed");
  assert.equal(result.results[0].step, "create_pr");
  assert.equal(result.results[0].method, "api");
  assert.equal(result.results[0].url, "https://github.com/owner/repo/pull/1");
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/pulls");
  assert.equal(request.body.head, "codex/fix-error");
});

test("executeGitPlan blocks denied PR body files before running commands", () => {
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  });
  const plan = buildFixGitPlan({
    changedFiles: ["src/app.js"],
    branch: "codex/fix-error",
    commitMessage: "fix: error",
    title: "Fix error",
    bodyFile: ".env",
    prDryRun: true
  });

  const result = executeGitPlan(process.cwd(), plan, engine, {
    runArgvWithPolicy() {
      throw new Error("runArgvWithPolicy should not be called");
    }
  });

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "git_plan_policy");
  assert.deepEqual(result.results, []);
  assert.equal(result.policy.pathResults[0].path, ".env");
});
