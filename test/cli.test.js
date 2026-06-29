import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

const bin = path.resolve("bin/vibeguard.js");

function writeCommandPolicy(root, { deny = [], requireConfirmation = [] } = {}) {
  const denyBlock = deny.length
    ? `\n${deny.map((command) => `    - "${command}"`).join("\n")}`
    : " []";
  const confirmBlock = requireConfirmation.length
    ? `\n${requireConfirmation.map((command) => `    - "${command}"`).join("\n")}`
    : " []";
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), `version: 1
paths:
  allow:
    - "**"
  deny: []
  require_confirmation: []
commands:
  deny:${denyBlock}
  require_confirmation:${confirmBlock}
`, "utf8");
}

async function startFakeGitHubApi() {
  const script = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    if (request.headers.accept && request.headers.accept.includes("diff")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("diff --git a/src/db.js b/src/db.js\\n--- a/src/db.js\\n+++ b/src/db.js\\n@@ -1 +1,2 @@\\n export function run() {}\\n+db.query(\\"SELECT * FROM users WHERE id = \\" + id)\\n");
      return;
    }
    if (request.method === "GET" && request.url.includes("/pulls/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ head: { sha: "abc123", ref: "codex/review" } }));
      return;
    }
    if (request.url.includes("/actions/runs")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        workflow_runs: [
          {
            id: 123,
            status: "completed",
            conclusion: "failure",
            name: "CI",
            head_branch: "main",
            event: "pull_request",
            workflow_name: "CI",
            html_url: "https://github.com/owner/repo/actions/runs/123",
            created_at: "2026-06-24T00:00:00Z",
            updated_at: "2026-06-24T00:01:00Z"
          }
        ]
      }));
      return;
    }
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ html_url: "https://github.com/owner/repo/pull/7", number: 7, request_body: body }));
  });
});
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for fake GitHub API: ${stderr}`));
    }, 5000);
    child.stdout.once("data", (chunk) => {
      clearTimeout(timer);
      resolve(String(chunk).trim());
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fake GitHub API exited early with code ${code}: ${stderr}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      child.kill();
    }
  };
}

test("CLI policy check prints JSON result", () => {
  const output = execFileSync(process.execPath, [bin, "policy", "check", "--path", "src/index.js", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.status, "allow");
});

test("CLI policy check requires confirmation for Git and PR state changes", () => {
  const output = execFileSync(process.execPath, [bin, "policy", "check", "--command", "git push -u origin codex/fix-bug", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.status, "require_confirmation");
});

test("CLI policy check can write audit JSONL", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-audit-"));
  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "policy",
    "check",
    "--path",
    "src/index.js",
    "--audit-log",
    "reports/audit.jsonl",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  const events = fs.readFileSync(path.join(root, "reports", "audit.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(parsed.auditLog.status, "written");
  assert.equal(events[0].operation, "policy_check_path");
  assert.equal(events[0].target, "src/index.js");
});

test("CLI policy check blocks denied patch input files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-policy-patch-denied-"));
  fs.writeFileSync(path.join(root, ".env"), `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`, "utf8");

  assert.throws(() => execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "policy",
    "check",
    "--patch",
    ".env",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  }), /Path matches deny policy/);
});

test("CLI audit summary reads policy-gated audit logs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-audit-summary-"));
  execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "policy",
    "check",
    "--path",
    "src/index.js",
    "--audit-log",
    "reports/audit.jsonl",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const output = execFileSync(process.execPath, [bin, "--root", root, "audit", "summary", "--file", "reports/audit.jsonl", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.summary.entries, 1);
  assert.equal(parsed.summary.operations.policy_check_path, 1);
  assert.equal(parsed.audit.policy.status, "allow");
});

test("CLI audit report writes policy-gated Markdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-audit-report-"));
  execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "policy",
    "check",
    "--path",
    "src/index.js",
    "--audit-log",
    "reports/audit.jsonl",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "audit",
    "report",
    "--file",
    "reports/audit.jsonl",
    "--output",
    "reports/audit.md",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.report.path, "reports/audit.md");
  assert.equal(parsed.report.policy.status, "allow");
  assert.match(fs.readFileSync(path.join(root, "reports", "audit.md"), "utf8"), /VibeGuard Audit Report/);
  assert.match(fs.readFileSync(path.join(root, "reports", "audit.md"), "utf8"), /policy_check_path/);
});

test("CLI debug accepts log file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), "version: 1\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "app.py"), "def run():\n    missing\n", "utf8");
  const log = path.join(root, "error.log");
  fs.writeFileSync(log, `Traceback (most recent call last):
  File "${path.join(root, "src", "app.py")}", line 2, in run
    missing
NameError: name 'missing' is not defined`, "utf8");

  const output = execFileSync(process.execPath, [bin, "--root", root, "debug", "--log", log, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.summary.type, "NameError");
  assert.deepEqual(parsed.likelyFiles, ["src/app.py"]);
});

test("CLI debug blocks denied log input files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-debug-denied-"));
  fs.writeFileSync(path.join(root, ".env"), "NameError: secret_log should not be read", "utf8");

  assert.throws(() => execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "debug",
    "--log",
    ".env",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  }), /Path matches deny policy/);
});

test("CLI onboard gates protected metadata reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-onboard-policy-"));
  fs.writeFileSync(path.join(root, "requirements.txt"), "Django==5.0\n", "utf8");

  const blocked = JSON.parse(execFileSync(process.execPath, [bin, "--root", root, "onboard", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  }));
  const confirmed = JSON.parse(execFileSync(process.execPath, [bin, "--root", root, "onboard", "--confirm", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  }));

  assert.equal(blocked.scan.metadataReadPolicy.status, "require_confirmation");
  assert.equal(blocked.scan.skippedMetadataFiles[0].file, "requirements.txt");
  assert.equal(blocked.scan.dependencies.some((dependency) => dependency.name === "Django"), false);
  assert.equal(confirmed.scan.metadataReadPolicy.status, "allow");
  assert.equal(confirmed.scan.dependencies.some((dependency) => dependency.name === "Django"), true);
  assert.equal(confirmed.scan.frameworks.includes("Django"), true);
});

test("CLI test command accepts coverage report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-coverage-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  fs.writeFileSync(path.join(root, "coverage.json"), JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [1],
        summary: { percent_covered: 0 }
      }
    }
  }), "utf8");
  fs.writeFileSync(path.join(root, "coverage-after.json"), JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [],
        summary: { percent_covered: 100 }
      }
    }
  }), "utf8");

  const output = execFileSync(process.execPath, [bin, "--root", root, "test", "--coverage", "coverage.json", "--coverage-after", "coverage-after.json", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.coverage.format, "coverage.py-json");
  assert.equal(parsed.candidates[0].coverage.missingLineCount, 1);
  assert.equal(parsed.coverageDelta.summary.missingLinesReduced, 1);
});

test("CLI test --write can run coverage command and report delta", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-coverage-command-"));
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

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "test",
    "--write",
    "--coverage",
    "coverage.json",
    "--coverage-command",
    "node coverage-script.cjs",
    "--run",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.coverageRuns.map((run) => [run.phase, run.status]), [["before", "passed"], ["after", "passed"]]);
  assert.equal(parsed.testRuns[0].status, "passed");
  assert.equal(parsed.coverageDeltaStatus.status, "compared");
  assert.equal(parsed.coverageDelta.summary.missingLinesReduced, 1);
});

test("CLI test command blocks denied coverage input files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-coverage-deny-"));
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");

  assert.throws(() => execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "test",
    "--coverage",
    ".env",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  }), /Path matches deny policy/);
});

test("CLI test --write can return a Git and PR dry-run plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-test-pr-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "test",
    "--write",
    "--create-branch",
    "--commit",
    "--pr-dry-run",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.deepEqual(parsed.gitPlan.changedFiles, ["src/math.test.js"]);
  assert.deepEqual(parsed.gitPlan.commands.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "create_pr"
  ]);
  assert.equal(parsed.gitPolicy.status, "require_confirmation");
});

test("CLI test --write blocks git plan execution without confirmation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-test-execute-pr-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "test",
    "--write",
    "--run",
    "--create-branch",
    "--commit",
    "--execute-git-plan",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.testRuns[0].status, "passed");
  assert.equal(parsed.gitPolicy.status, "require_confirmation");
  assert.equal(parsed.gitExecution.status, "require_confirmation");
  assert.equal(parsed.gitExecution.stage, "git_plan_policy");
});

test("CLI test --write --run --repair repairs Python generated test imports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-test-repair-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "helper.py"), "VALUE = 'Ada'\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "greeting.py"), `from helper import VALUE

def greeting():
    return VALUE
`, "utf8");

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "test",
    "--write",
    "--run",
    "--repair",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.initialTestRuns[0].status, "failed");
  assert.equal(parsed.initialTestRuns[0].failureAnalysis.category, "python_local_import_path");
  assert.equal(parsed.repairRuns[0].status, "repaired");
  assert.equal(parsed.testRuns[0].status, "passed");
  assert.equal(parsed.testRuns[0].repaired, true);
});

test("CLI hooks install checks .git hook path policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-hook-policy-"));

  let output;
  try {
    output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "hooks",
      "install",
      "pre-commit",
      "--allow-git-dir",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
  } catch (error) {
    output = error.stdout;
  }
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "deny");
  assert.equal(parsed.stage, "hook_install_policy");
  assert.equal(parsed.path, ".git/hooks/pre-commit");
  assert.match(parsed.policy.reason, /Path matches deny policy/);
});

test("CLI debug --ai-patch marks non-diff AI output as denied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-ai-"));
  fs.writeFileSync(path.join(root, ".vibeguard.yaml"), "version: 1\n", "utf8");
  const log = path.join(root, "error.log");
  fs.writeFileSync(log, "ReferenceError: bad is not defined", "utf8");

  const output = execFileSync(process.execPath, [bin, "--root", root, "debug", "--log", "error.log", "--ai-patch", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_LLM_PROVIDER: "fixture",
      VIBEGUARD_FIXTURE_PATCH: "not a diff"
    }
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.aiPatch.validation.valid, false);
  assert.equal(parsed.aiPatch.policy.status, "deny");
});

test("CLI debug --ai-patch can write a policy-gated patch artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-ai-output-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "old\n", "utf8");
  fs.writeFileSync(path.join(root, "error.log"), "ReferenceError: oldName is not defined", "utf8");
  const patch = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "debug",
    "--log",
    "error.log",
    "--ai-patch",
    "--output-patch",
    "reports/generated.patch",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_LLM_PROVIDER: "fixture",
      VIBEGUARD_FIXTURE_PATCH: patch
    }
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.aiPatch.validation.valid, true);
  assert.equal(parsed.aiPatch.policy.status, "allow");
  assert.equal(parsed.aiPatch.outputPatch.path, "reports/generated.patch");
  assert.match(fs.readFileSync(path.join(root, "reports", "generated.patch"), "utf8"), /diff --git a\/src\/app\.js b\/src\/app\.js/);
});

test("CLI review can write a policy-gated comment body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-comment-"));
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  const diff = `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`;
  fs.writeFileSync(path.join(root, "reports", "change.diff"), diff, "utf8");

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "review",
    "--diff",
    "reports/change.diff",
    "--write-comment",
    "reports/review.md",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.writtenComment.path, "reports/review.md");
  assert.equal(parsed.writtenComment.policy.status, "allow");
  assert.match(fs.readFileSync(path.join(root, "reports", "review.md"), "utf8"), /VibeGuard Review/);
});

test("CLI review blocks denied diff input paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-denied-"));
  fs.writeFileSync(path.join(root, ".env"), "diff --git a/src/app.js b/src/app.js\n", "utf8");

  assert.throws(() => execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "review",
    "--diff",
    ".env",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  }), /Path matches deny policy/);
});

test("CLI review checks git diff command policy before default diff reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-git-diff-policy-"));
  writeCommandPolicy(root, { deny: ["git diff"] });

  let output;
  try {
    output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "review",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
  } catch (error) {
    output = error.stdout;
  }
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "deny");
  assert.equal(parsed.stage, "review_git_diff_policy");
  assert.equal(parsed.command, "git diff --cached");
  assert.match(parsed.policy.reason, /Command matches deny policy: git diff/);
});

test("CLI review can fetch GitHub PR diff through REST fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-github-pr-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  const api = await startFakeGitHubApi();

  let parsed;
  try {
    const output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "review",
      "--github-pr",
      "12",
      "--github-api",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "token",
        GITHUB_API_URL: api.url
      }
    });
    parsed = JSON.parse(output);
  } finally {
    api.close();
  }

  assert.match(parsed.summary, /1 changed file/);
  assert.ok(parsed.findings.some((finding) => finding.file === "src/db.js" && finding.category === "security"));
});

test("CLI review publish comment execute requires confirmation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-publish-policy-"));
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`, "utf8");

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "review",
    "--diff",
    "reports/change.diff",
    "--comment-pr",
    "12",
    "--execute",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "require_confirmation");
  assert.equal(parsed.stage, "review_comment_policy");
  assert.equal(parsed.review.reviewComments.length, 1);
  assert.match(parsed.publish.command, /gh pr comment 12/);
});

test("CLI review can publish a generated PR comment through REST fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-publish-api-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`, "utf8");
  const api = await startFakeGitHubApi();

  let parsed;
  try {
    const output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "review",
      "--diff",
      "reports/change.diff",
      "--comment-pr",
      "12",
      "--execute",
      "--confirm",
      "--github-api",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "token",
        GITHUB_API_URL: api.url
      }
    });
    parsed = JSON.parse(output);
  } finally {
    api.close();
  }

  assert.equal(parsed.status, "commented");
  assert.equal(parsed.commandPolicy.status, "allow");
  assert.equal(parsed.publish.method, "api");
  assert.match(parsed.publish.url, /github\.com\/owner\/repo\/pull\/7/);
  assert.ok(parsed.review.findings.some((finding) => finding.file === "src/db.js" && finding.category === "security"));
});

test("CLI GitHub review-comments builds a policy-gated batch dry-run from a diff", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-comments-"));
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "change.diff"), `diff --git a/src/db.js b/src/db.js
--- a/src/db.js
+++ b/src/db.js
@@ -1 +1,2 @@
 export function run() {}
+db.query("SELECT * FROM users WHERE id = " + id)
`, "utf8");

  const dryRunOutput = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "review-comments",
    "--pr",
    "12",
    "--commit",
    "abc123",
    "--diff",
    "reports/change.diff",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const dryRun = JSON.parse(dryRunOutput);

  assert.equal(dryRun.status, "dry_run");
  assert.equal(dryRun.review.reviewComments.length, 1);
  assert.equal(dryRun.publish.count, 1);
  assert.equal(dryRun.commandPolicy.status, "require_confirmation");
  assert.match(dryRun.publish.comments[0].command, /gh api repos\/\{owner\}\/\{repo\}\/pulls\/12\/comments/);

  const executeOutput = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "review-comments",
    "--pr",
    "12",
    "--commit",
    "abc123",
    "--diff",
    "reports/change.diff",
    "--execute",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const execute = JSON.parse(executeOutput);

  assert.equal(execute.status, "require_confirmation");
  assert.equal(execute.stage, "github_review_comments_policy");
  assert.equal(execute.publish.count, 1);
});

test("CLI GitHub review-comments can infer commit from PR head", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-review-head-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  const api = await startFakeGitHubApi();
  let parsed;

  try {
    const output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "github",
      "review-comments",
      "--pr",
      "12",
      "--github-pr",
      "12",
      "--github-api",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "token",
        GITHUB_API_URL: api.url
      }
    });
    parsed = JSON.parse(output);
  } finally {
    api.close();
  }

  assert.equal(parsed.status, "dry_run");
  assert.equal(parsed.head.headSha, "abc123");
  assert.equal(parsed.publish.count, 1);
  assert.match(parsed.publish.comments[0].command, /commit_id=abc123/);
});

test("CLI GitHub checks execute is gated by command policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-checks-policy-"));
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

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "checks",
    "--branch",
    "main",
    "--execute",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "require_confirmation");
  assert.equal(parsed.stage, "github_checks_policy");
  assert.match(parsed.command, /gh run list/);
  assert.equal(parsed.dryRun.status, "dry_run");
});

test("CLI GitHub checks returns a normalized CI summary through REST fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-checks-api-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  writeCommandPolicy(root, { requireConfirmation: ["gh run list"] });
  const api = await startFakeGitHubApi();

  let parsed;
  try {
    const output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "github",
      "checks",
      "--branch",
      "main",
      "--limit",
      "5",
      "--wait",
      "--wait-timeout",
      "1",
      "--wait-interval",
      "0",
      "--execute",
      "--confirm",
      "--github-api",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "token",
        GITHUB_API_URL: api.url
      }
    });
    parsed = JSON.parse(output);
  } finally {
    api.close();
  }

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.method, "api");
  assert.equal(parsed.commandPolicy.status, "allow");
  assert.equal(parsed.summary.status, "failing");
  assert.equal(parsed.summary.gate, "fail");
  assert.equal(parsed.summary.failingRuns[0].name, "CI");
  assert.equal(parsed.wait.status, "completed");
  assert.equal(parsed.wait.attempts, 1);
});

test("CLI GitHub detect is gated by command policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-detect-policy-"));
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

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "detect",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "require_confirmation");
  assert.equal(parsed.stage, "github_detect_policy");
  assert.equal(parsed.command, "git remote get-url origin");
});

test("CLI GitHub auth reports secret-safe write readiness", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-auth-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "auth",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_DISABLE_DOTENV: "1",
      GITHUB_TOKEN: "cli-secret",
      GH_TOKEN: ""
    }
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "completed");
  assert.equal(parsed.github.status, "detected");
  assert.equal(parsed.githubAuth.hasToken, true);
  assert.equal(parsed.githubAuth.canWrite, true);
  assert.equal(parsed.nextActions.some((action) => action.id === "enable_github_execution"), false);
  assert.equal(output.includes("cli-secret"), false);
});

test("CLI GitHub PR execute checks branch prerequisite policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-pr-branch-policy-"));
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

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "pr",
    "--title",
    "Fix bug",
    "--execute",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "require_confirmation");
  assert.equal(parsed.stage, "github_pr_prerequisite_policy");
  assert.equal(parsed.command, "git branch --show-current");
});

test("CLI GitHub PR can force REST API fallback with --github-api", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-pr-api-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  writeCommandPolicy(root, { requireConfirmation: ["gh pr create"] });
  const api = await startFakeGitHubApi();

  let parsed;
  try {
    const output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "github",
      "pr",
      "--title",
      "Fix bug",
      "--body",
      "body",
      "--head",
      "codex/fix-bug",
      "--draft",
      "--execute",
      "--confirm",
      "--github-api",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: "token",
        GITHUB_API_URL: api.url
      }
    });
    parsed = JSON.parse(output);
  } finally {
    api.close();
  }

  assert.equal(parsed.status, "created");
  assert.equal(parsed.method, "api");
  assert.equal(parsed.url, "https://github.com/owner/repo/pull/7");
  assert.equal(parsed.number, 7);
});

test("CLI GitHub PR dry-run includes a compare URL when remote is available", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-pr-compare-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "pr",
    "--title",
    "Fix bug",
    "--body",
    "body",
    "--base",
    "main",
    "--head",
    "codex/fix-bug",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_DISABLE_DOTENV: "1"
    }
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "dry_run");
  assert.equal(parsed.compare.status, "available");
  assert.equal(parsed.compareUrl, "https://github.com/owner/repo/compare/main...codex%2Ffix-bug?expand=1");
});

test("CLI GitHub PR REST execute returns structured auth_required without a token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-pr-auth-"));
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "github",
    "pr",
    "--title",
    "Fix bug",
    "--body",
    "body",
    "--head",
    "codex/fix-bug",
    "--execute",
    "--confirm",
    "--github-api",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_DISABLE_DOTENV: "1",
      GITHUB_TOKEN: "",
      GH_TOKEN: ""
    }
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "auth_required");
  assert.equal(parsed.stage, "github_auth");
  assert.equal(parsed.operation, "github_pr");
  assert.equal(parsed.githubAuth.canWrite, false);
  assert.equal(parsed.compare.status, "available");
  assert.equal(parsed.compareUrl, "https://github.com/owner/repo/compare/main...codex%2Ffix-bug?expand=1");
  assert.equal(parsed.nextActions[0].id, "enable_github_execution");
});

test("CLI pr summary can write a policy-gated body file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-pr-body-"));
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  const diff = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;
  fs.writeFileSync(path.join(root, "reports", "change.diff"), diff, "utf8");

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "pr",
    "summary",
    "--diff",
    "reports/change.diff",
    "--write-body",
    "reports/pr-body.md",
    "--check-ci",
    "--wait-ci",
    "--ci-timeout",
    "1",
    "--ci-interval",
    "0",
    "--ci-limit",
    "3",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.writtenBody.path, "reports/pr-body.md");
  assert.equal(parsed.writtenBody.policy.status, "allow");
  assert.equal(parsed.title, "Add coverage for app");
  assert.equal(parsed.branch, "codex/add-tests-app");
  assert.equal(parsed.commitMessage, "test: add coverage for app");
  assert.deepEqual(parsed.automation.changedFiles, ["src/app.js"]);
  assert.match(fs.readFileSync(path.join(root, "reports", "pr-body.md"), "utf8"), /Review Action Items/);
});

test("CLI pr plan returns a policy-gated branch commit and PR dry-run plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-pr-plan-"));
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  const diff = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;
  fs.writeFileSync(path.join(root, "reports", "change.diff"), diff, "utf8");

  const output = execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "pr",
    "plan",
    "--diff",
    "reports/change.diff",
    "--write-body",
    "reports/pr-body.md",
    "--check-ci",
    "--wait-ci",
    "--ci-timeout",
    "1",
    "--ci-interval",
    "0",
    "--ci-limit",
    "3",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.writtenBody.path, "reports/pr-body.md");
  assert.equal(parsed.branch, "codex/add-tests-app");
  assert.equal(parsed.commitMessage, "test: add coverage for app");
  assert.deepEqual(parsed.gitPlan.commands.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "create_pr"
  ]);
  assert.equal(parsed.gitPolicy.status, "require_confirmation");
  assert.equal(parsed.gitExecution, null);
  assert.equal(parsed.ciStatus.status, "dry_run");
  assert.match(parsed.ciStatus.command, /gh run list --limit 3/);
  assert.match(parsed.ciStatus.command, /--branch codex\/add-tests-app/);
  assert.equal(parsed.ciStatus.wait.status, "dry_run");
});

test("CLI pr summary checks git diff command policy before default diff reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-pr-git-diff-policy-"));
  writeCommandPolicy(root, { deny: ["git diff"] });

  let output;
  try {
    output = execFileSync(process.execPath, [
      bin,
      "--root",
      root,
      "pr",
      "summary",
      "--json"
    ], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
  } catch (error) {
    output = error.stdout;
  }
  const parsed = JSON.parse(output);

  assert.equal(parsed.status, "deny");
  assert.equal(parsed.stage, "pr_summary_git_diff_policy");
  assert.equal(parsed.command, "git diff");
  assert.match(parsed.policy.reason, /Command matches deny policy: git diff/);
});

test("CLI patch check blocks denied patch input files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-cli-patch-file-denied-"));
  fs.writeFileSync(path.join(root, ".env"), `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`, "utf8");

  assert.throws(() => execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "patch",
    "check",
    "--file",
    ".env",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  }), /Path matches deny policy/);
});
