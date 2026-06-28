import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { handleMcpRequest, mcpInternals } from "../src/mcp/server.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-mcp-"));
}

function tempGitRepo() {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "old\n", "utf8");
  return root;
}

async function startFakeActionsApi() {
  const server = http.createServer((request, response) => {
    if (request.url.includes("/actions/runs")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        workflow_runs: [
          {
            id: 456,
            status: "queued",
            conclusion: null,
            name: "CI",
            head_branch: "main",
            event: "pull_request",
            workflow_name: "CI",
            html_url: "https://github.com/owner/repo/actions/runs/456",
            created_at: "2026-06-24T00:00:00Z",
            updated_at: "2026-06-24T00:01:00Z"
          }
        ]
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function startFakePullApi() {
  const server = http.createServer((request, response) => {
    if (request.headers.accept && request.headers.accept.includes("diff")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`);
      return;
    }
    if (request.method === "GET" && request.url.includes("/pulls/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ head: { sha: "abc123", ref: "codex/review" } }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("MCP tools expose input schemas", () => {
  for (const tool of mcpInternals.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description);
  }
  assert.ok(mcpInternals.tools.some((tool) => tool.name === "github_pr"));
  assert.ok(mcpInternals.tools.some((tool) => tool.name === "apply_patch_safely"));
  const byName = new Map(mcpInternals.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("fix_error").inputSchema.properties.githubUseApi.type, "boolean");
  assert.equal(byName.get("write_tests").inputSchema.properties.githubUseApi.type, "boolean");
  assert.equal(byName.get("write_tests").inputSchema.properties.coverageCommand.type, "string");
  assert.equal(byName.get("review_pr").inputSchema.properties.githubPr.type, "string");
  assert.equal(byName.get("review_pr").inputSchema.properties.publishComment.type, "boolean");
  assert.equal(byName.get("review_pr").inputSchema.properties.commentPr.type, "string");
  assert.equal(byName.get("summarize_pr").inputSchema.properties.githubPr.type, "string");
  assert.equal(byName.get("plan_pr").inputSchema.properties.executeGitPlan.type, "boolean");
  assert.equal(byName.get("plan_pr").inputSchema.properties.checkCi.type, "boolean");
  assert.equal(byName.get("plan_pr").inputSchema.properties.ciLimit.type, "number");
  assert.equal(byName.get("plan_pr").inputSchema.properties.githubUseApi.type, "boolean");
  assert.equal(byName.get("github_pr").inputSchema.properties.useApi.type, "boolean");
  assert.equal(byName.get("github_checks").inputSchema.properties.confirmed.type, "boolean");
  assert.equal(byName.get("github_checks").inputSchema.properties.auditLog.type, "string");
  assert.equal(byName.get("detect_github").inputSchema.properties.auditLog.type, "string");
  assert.equal(byName.get("onboard_repo").inputSchema.properties.confirmed.type, "boolean");
});

test("MCP initialize returns server info and tool capabilities", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  }, tempRepo());

  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.serverInfo.name, "vibeguard-ai-dev-agent");
  assert.ok(response.result.capabilities.tools);
  assert.ok(response.result.capabilities.resources);
  assert.ok(response.result.capabilities.prompts);
});

test("MCP list and utility methods return protocol-compatible results", async () => {
  const root = tempRepo();
  const tools = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/list"
  }, root);
  const resources = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 21,
    method: "resources/list"
  }, root);
  const resourceTemplates = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 22,
    method: "resources/templates/list"
  }, root);
  const prompts = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 23,
    method: "prompts/list"
  }, root);
  const ping = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 24,
    method: "ping"
  }, root);
  const logging = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 25,
    method: "logging/setLevel",
    params: { level: "warning" }
  }, root);

  assert.ok(tools.result.tools.some((tool) => tool.name === "check_policy"));
  assert.deepEqual(resources.result.resources, []);
  assert.deepEqual(resourceTemplates.result.resourceTemplates, []);
  assert.deepEqual(prompts.result.prompts, []);
  assert.deepEqual(ping.result, {});
  assert.deepEqual(logging.result, {});
});

test("MCP tools/call returns text content and structured content", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "check_policy",
      arguments: { path: "src/index.js" }
    }
  }, tempRepo());

  assert.equal(response.result.content[0].type, "text");
  assert.equal(JSON.parse(response.result.content[0].text).status, "allow");
  assert.equal(response.result.structuredContent.status, "allow");
});

test("MCP tools/call returns structured tool errors", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "check_policy",
      arguments: {}
    }
  }, tempRepo());

  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.status, "error");
  assert.match(response.result.structuredContent.error, /requires path, command, or patch/);
});

test("MCP tools/call validates required arguments", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "audit_report",
      arguments: {}
    }
  }, tempRepo());

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Missing required argument: output/);
});

test("MCP tools/call rejects unknown and mistyped arguments", async () => {
  const unknown = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "check_policy",
      arguments: { path: "src/index.js", extra: true }
    }
  }, tempRepo());
  const mistyped = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "write_tests",
      arguments: { limit: "2" }
    }
  }, tempRepo());

  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.structuredContent.error, /Unknown argument: extra/);
  assert.equal(mistyped.result.isError, true);
  assert.match(mistyped.result.structuredContent.error, /limit must be a number/);
});

test("MCP initialized notification does not produce a response", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, tempRepo());

  assert.equal(response, null);
});

test("MCP notifications do not produce error responses", async () => {
  const cancelled = await handleMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 12 }
  }, tempRepo());
  const unknown = await handleMcpRequest({
    jsonrpc: "2.0",
    method: "notifications/custom"
  }, tempRepo());

  assert.equal(cancelled, null);
  assert.equal(unknown, null);
});

test("MCP onboard_repo gates protected metadata reads", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "requirements.txt"), "Django==5.0\n", "utf8");

  const blocked = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "onboard_repo",
      arguments: {}
    }
  }, root);
  const confirmed = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "onboard_repo",
      arguments: { confirmed: true }
    }
  }, root);

  assert.equal(blocked.result.structuredContent.scan.metadataReadPolicy.status, "require_confirmation");
  assert.equal(blocked.result.structuredContent.scan.skippedMetadataFiles[0].file, "requirements.txt");
  assert.equal(blocked.result.structuredContent.scan.dependencies.some((dependency) => dependency.name === "Django"), false);
  assert.equal(confirmed.result.structuredContent.scan.metadataReadPolicy.status, "allow");
  assert.equal(confirmed.result.structuredContent.scan.dependencies.some((dependency) => dependency.name === "Django"), true);
});

test("MCP review_pr reads diff files through path policy", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "review_pr",
      arguments: {
        diffFile: "reports/change.diff"
      }
    }
  }, root);

  const result = response.result.structuredContent;
  assert.equal(result.files[0], "src/db.js");
  assert.ok(result.findings.some((finding) => finding.category === "security"));
});

test("MCP review_pr blocks denied diff files before analysis", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "review_pr",
      arguments: {
        diffFile: ".env"
      }
    }
  }, root);

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Path matches deny policy: \.env/);
});

test("MCP review_pr can build a PR comment publish dry-run", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: "review_pr",
      arguments: {
        diffFile: "reports/change.diff",
        commentPr: "12"
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.status, "dry_run");
  assert.equal(result.commandPolicy.status, "require_confirmation");
  assert.equal(result.review.reviewComments.length, 1);
  assert.match(result.publish.command, /gh pr comment 12/);
});

test("MCP summarize_pr reads diff files through path policy", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1,2 @@
 export function run() {}
+// TODO wire validation
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: {
      name: "summarize_pr",
      arguments: {
        diffFile: "reports/change.diff"
      }
    }
  }, root);

  const result = response.result.structuredContent;
  assert.match(result.body, /src\/app\.js/);
  assert.equal(result.branch, "codex/add-tests-app");
  assert.equal(result.commitMessage, "test: add coverage for app");
  assert.deepEqual(result.automation.changedFiles, ["src/app.js"]);
  assert.ok(result.review.findings.some((finding) => finding.category === "maintainability"));
});

test("MCP plan_pr prepares a policy-gated Git and PR plan", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 141,
    method: "tools/call",
    params: {
      name: "plan_pr",
      arguments: {
        diffFile: "reports/change.diff",
        writeBody: "reports/pr-body.md",
        checkCi: true,
        ciLimit: 2
      }
    }
  }, root);

  const result = response.result.structuredContent;
  assert.equal(result.writtenBody.path, "reports/pr-body.md");
  assert.equal(result.title, "Add coverage for app");
  assert.equal(result.branch, "codex/add-tests-app");
  assert.equal(result.commitMessage, "test: add coverage for app");
  assert.deepEqual(result.gitPlan.commands.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "create_pr"
  ]);
  assert.equal(result.gitPlan.commands.find((command) => command.step === "create_pr").bodyFile, "reports/pr-body.md");
  assert.equal(result.gitPolicy.status, "require_confirmation");
  assert.equal(result.gitExecution, null);
  assert.equal(result.ciStatus.status, "dry_run");
  assert.match(result.ciStatus.command, /gh run list --limit 2/);
  assert.match(result.ciStatus.command, /--branch codex\/add-tests-app/);
});

test("MCP github_pr returns a dry-run PR command", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "github_pr",
      arguments: {
        title: "Fix bug",
        body: "body",
        draft: true
      }
    }
  }, tempRepo());

  assert.equal(response.result.structuredContent.status, "dry_run");
  assert.match(response.result.structuredContent.command, /gh pr create/);
  assert.match(response.result.structuredContent.command, /--draft/);
});

test("MCP github_comment blocks denied body files before dry-run", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "github_comment",
      arguments: {
        pr: "12",
        bodyFile: ".env"
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "github_comment_body_file_policy");
  assert.equal(result.policy.path, ".env");
});

test("MCP github_review_comment returns a dry-run review comment command", async () => {
  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: {
      name: "github_review_comment",
      arguments: {
        pr: "12",
        body: "review",
        commitId: "abc123",
        path: "src/app.js",
        line: 10
      }
    }
  }, tempRepo());
  const result = response.result.structuredContent;

  assert.equal(result.status, "dry_run");
  assert.match(result.command, /gh api repos\/\{owner\}\/\{repo\}\/pulls\/12\/comments/);
  assert.match(result.command, /commit_id=abc123/);
});

test("MCP github_review_comment blocks denied body files before dry-run", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: "github_review_comment",
      arguments: {
        pr: "12",
        bodyFile: ".env",
        commitId: "abc123",
        path: "src/app.js",
        line: 10
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "github_review_comment_body_file_policy");
  assert.equal(result.policy.path, ".env");
});

test("MCP github_review_comments builds a batch dry-run from a policy-gated diff file", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 16,
    method: "tools/call",
    params: {
      name: "github_review_comments",
      arguments: {
        pr: "12",
        commitId: "abc123",
        diffFile: "reports/change.diff"
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.status, "dry_run");
  assert.equal(result.review.reviewComments.length, 1);
  assert.equal(result.publish.count, 1);
  assert.equal(result.commandPolicy.status, "require_confirmation");
  assert.match(result.publish.comments[0].command, /gh api repos\/\{owner\}\/\{repo\}\/pulls\/12\/comments/);
});

test("MCP github_review_comments blocks denied diff files before analysis", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".env"), "diff --git a/src/app.js b/src/app.js\n", "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 17,
    method: "tools/call",
    params: {
      name: "github_review_comments",
      arguments: {
        pr: "12",
        commitId: "abc123",
        diffFile: ".env"
      }
    }
  }, root);

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Path matches deny policy: \.env/);
});

test("MCP github_review_comments can infer commit from PR head", async () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  const api = await startFakePullApi();
  const oldToken = process.env.GITHUB_TOKEN;
  const oldApiUrl = process.env.GITHUB_API_URL;

  try {
    process.env.GITHUB_TOKEN = "token";
    process.env.GITHUB_API_URL = api.url;
    const response = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: {
        name: "github_review_comments",
        arguments: {
          pr: "12",
          githubPr: "12",
          useApi: true
        }
      }
    }, root);
    const result = response.result.structuredContent;

    assert.equal(result.status, "dry_run");
    assert.equal(result.head.headSha, "abc123");
    assert.equal(result.publish.count, 1);
    assert.match(result.publish.comments[0].command, /commit_id=abc123/);
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
    if (oldApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = oldApiUrl;
    await api.close();
  }
});

test("MCP github_checks execute is gated by command policy", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny: []
  require_confirmation:
    - "gh run list"
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 18,
    method: "tools/call",
    params: {
      name: "github_checks",
      arguments: {
        branch: "main",
        execute: true
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.status, "require_confirmation");
  assert.equal(result.stage, "github_checks_policy");
  assert.match(result.command, /gh run list/);
  assert.equal(result.dryRun.status, "dry_run");
});

test("MCP github_checks returns a normalized CI summary through REST fallback", async () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny: []
  require_confirmation:
    - "gh run list"
`, "utf8");
  const api = await startFakeActionsApi();
  const oldToken = process.env.GITHUB_TOKEN;
  const oldApiUrl = process.env.GITHUB_API_URL;
  try {
    process.env.GITHUB_TOKEN = "token";
    process.env.GITHUB_API_URL = api.url;
    const response = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "github_checks",
        arguments: {
          branch: "main",
          execute: true,
          confirmed: true,
          useApi: true
        }
      }
    }, root);
    const result = response.result.structuredContent;

    assert.equal(result.status, "completed");
    assert.equal(result.method, "api");
    assert.equal(result.summary.status, "pending");
    assert.equal(result.summary.gate, "wait");
    assert.equal(result.summary.pendingRuns[0].name, "CI");
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
    if (oldApiUrl === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = oldApiUrl;
    await api.close();
  }
});

test("MCP detect_github is gated by command policy", async () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny: []
  require_confirmation:
    - "git remote get-url origin"
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 19,
    method: "tools/call",
    params: {
      name: "detect_github",
      arguments: {}
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.status, "require_confirmation");
  assert.equal(result.stage, "github_detect_policy");
  assert.equal(result.command, "git remote get-url origin");
});

test("MCP github_pr execute checks branch prerequisite policy", async () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny: []
  require_confirmation:
    - "git branch --show-current"
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "github_pr",
      arguments: {
        title: "Fix bug",
        execute: true
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.status, "require_confirmation");
  assert.equal(result.stage, "github_pr_prerequisite_policy");
  assert.equal(result.command, "git branch --show-current");
});

test("MCP debug_error reads log files through path policy", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "error.log"), "ReferenceError: oldName is not defined\n", "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "debug_error",
      arguments: {
        logFile: "error.log"
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.summary.type, "ReferenceError");
  assert.equal(result.logFileRead.path, "error.log");
  assert.equal(result.logFileRead.policy.status, "allow");
});

test("MCP debug_error can generate and write a policy-gated AI patch artifact", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "old\n", "utf8");
  const patch = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;
  const envKeys = [
    "VIBEGUARD_LLM_PROVIDER",
    "VIBEGUARD_FIXTURE_PATCH",
    "VIBEGUARD_FIXTURE_PATCH_FILE",
    "VIBEGUARD_FIXTURE_PATCH_MAP"
  ];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.VIBEGUARD_LLM_PROVIDER = "fixture";
    process.env.VIBEGUARD_FIXTURE_PATCH = patch;
    delete process.env.VIBEGUARD_FIXTURE_PATCH_FILE;
    delete process.env.VIBEGUARD_FIXTURE_PATCH_MAP;

    const response = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "debug_error",
        arguments: {
          log: "ReferenceError: oldName is not defined",
          aiPatch: true,
          outputPatch: "reports/generated.patch"
        }
      }
    }, root);
    const result = response.result.structuredContent;

    assert.equal(result.aiPatch.validation.valid, true);
    assert.equal(result.aiPatch.policy.status, "allow");
    assert.equal(result.aiPatch.outputPatch.path, "reports/generated.patch");
    assert.match(fs.readFileSync(path.join(root, "reports", "generated.patch"), "utf8"), /diff --git a\/src\/app\.js b\/src\/app\.js/);
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("MCP fix_error blocks denied patch file reads", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".env"), "not a patch\n", "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "fix_error",
      arguments: {
        log: "ReferenceError: oldName is not defined",
        patchFile: ".env"
      }
    }
  }, root);

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Path matches deny policy: \.env/);
});

test("MCP write_tests can repair generated Python test imports", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "helper.py"), "VALUE = 'Ada'\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "greeting.py"), `from helper import VALUE

def greeting():
    return VALUE
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "write_tests",
      arguments: {
        write: true,
        run: true,
        repair: true,
        limit: 1
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.equal(result.initialTestRuns[0].status, "failed");
  assert.equal(result.initialTestRuns[0].failureAnalysis.category, "python_local_import_path");
  assert.equal(result.repairRuns[0].status, "repaired");
  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.testRuns[0].repaired, true);
});

test("MCP write_tests can run coverage command and return coverage delta", async () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "math.js"), `export function uncovered() {
  return false;
}
`, "utf8");
  fs.writeFileSync(path.join(root, "coverage-script.cjs"), `const fs = require("node:fs");
const hasGeneratedTest = fs.existsSync("src/math.test.js");
fs.writeFileSync("coverage.json", JSON.stringify({
  files: {
    "src/math.js": {
      missing_lines: hasGeneratedTest ? [] : [2],
      summary: { percent_covered: hasGeneratedTest ? 100 : 0 }
    }
  }
}));
`, "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "write_tests",
      arguments: {
        write: true,
        run: true,
        limit: 1,
        coverageFile: "coverage.json",
        coverageCommand: "node coverage-script.cjs"
      }
    }
  }, root);
  const result = response.result.structuredContent;

  assert.deepEqual(result.coverageRuns.map((run) => [run.phase, run.status]), [["before", "passed"], ["after", "passed"]]);
  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.coverageDeltaStatus.status, "compared");
  assert.equal(result.coverageDelta.summary.missingLinesReduced, 1);
});

test("MCP write_tests blocks denied coverage files before analysis", async () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "write_tests",
      arguments: {
        coverageFile: ".env"
      }
    }
  }, root);

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Path matches deny policy: \.env/);
});

test("MCP apply_patch_safely checks a patch without modifying files", async () => {
  const root = tempGitRepo();
  const patch = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "apply_patch_safely",
      arguments: { patch }
    }
  }, root);

  assert.equal(response.result.structuredContent.status, "checked");
  assert.equal(response.result.structuredContent.policy.status, "allow");
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "old\n");
});

test("MCP apply_patch_safely blocks denied patch files", async () => {
  const root = tempGitRepo();
  const patch = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1 @@
-A=1
+A=2
`;

  const response = await handleMcpRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "apply_patch_safely",
      arguments: { patch }
    }
  }, root);

  assert.equal(response.result.isError, true);
  assert.match(response.result.structuredContent.error, /Patch contains deny file changes: \.env/);
});
