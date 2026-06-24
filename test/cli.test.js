import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const bin = path.resolve("bin/vibeguard.js");

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
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);

  assert.equal(parsed.writtenBody.path, "reports/pr-body.md");
  assert.equal(parsed.writtenBody.policy.status, "allow");
  assert.match(fs.readFileSync(path.join(root, "reports", "pr-body.md"), "utf8"), /Review Action Items/);
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
