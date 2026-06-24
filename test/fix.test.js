import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PolicyEngine } from "../src/policy/engine.js";
import { runFixWorkflow } from "../src/agents/fix.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "../src/patch/validatePatch.js";

const bin = path.resolve("bin/vibeguard.js");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyFixture(name) {
  const target = tempDir(`vibeguard-${name}-`);
  fs.cpSync(path.resolve("fixtures", name), target, { recursive: true });
  execFileSync("git", ["init"], { cwd: target, encoding: "utf8" });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: target, encoding: "utf8" });
  execFileSync("git", ["add", "."], { cwd: target, encoding: "utf8" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"], {
    cwd: target,
    encoding: "utf8"
  });
  return target;
}

function runCli(args, options = {}) {
  try {
    const output = execFileSync(process.execPath, [bin, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: options.env || process.env
    });
    return JSON.parse(output);
  } catch (error) {
    if (!options.allowFailure) throw error;
    return JSON.parse(error.stdout);
  }
}

test("validateUnifiedDiff rejects empty and non-diff patch text", () => {
  assert.equal(validateUnifiedDiff("").valid, false);
  assert.equal(validateUnifiedDiff("change src/app.js").valid, false);
});

test("normalizeUnifiedDiff extracts fenced patch and repairs hunk counts", () => {
  const patch = `Here is the fix:

\`\`\`diff
diff --git a/src/greeter.py b/src/greeter.py
--- a/src/greeter.py
+++ b/src/greeter.py
@@ -1,3 +1,3 @@
 def greet(name):
-    return f"hello {user_name.strip().lower()}"
+    return f"hello {name.strip().lower()}"
\`\`\``;

  const normalized = normalizeUnifiedDiff(patch);
  assert.match(normalized, /^diff --git/m);
  assert.match(normalized, /@@ -1,2 \+1,2 @@/);
  assert.equal(validateUnifiedDiff(normalized).valid, true);
});

test("fix workflow blocks non-diff patch output", async () => {
  const root = tempDir("vibeguard-invalid-patch-");
  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const result = await runFixWorkflow({
    root,
    engine,
    logText: "ReferenceError: x is not defined",
    patchText: "not a diff"
  });

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "patch_validation");
});

test("fix workflow blocks sensitive patch files before apply", async () => {
  const root = tempDir("vibeguard-sensitive-patch-");
  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: [".env"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });
  const patch = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1 @@
-A=1
+A=2
`;

  const result = await runFixWorkflow({
    root,
    engine,
    logText: "Error: bad secret",
    patchText: patch
  });

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "policy");
});

test("fix CLI applies Python fixture patch and runs tests", () => {
  const root = copyFixture("python-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/name-error.patch",
    "--test",
    "python -m unittest discover -s tests",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.applyResult.status, "applied");
  assert.equal(result.tests.status, "passed");
  assert.match(fs.readFileSync(path.join(root, "src", "greeter.py"), "utf8"), /name\.strip/);
});

test("fix CLI dry-run checks Node fixture patch without modifying files", () => {
  const root = copyFixture("node-bug");
  const before = fs.readFileSync(path.join(root, "src", "user.js"), "utf8");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--test",
    "npm test",
    "--dry-run",
    "--json"
  ]);

  assert.equal(result.status, "dry_run");
  assert.equal(result.applyCheck.status, "checked");
  assert.equal(fs.readFileSync(path.join(root, "src", "user.js"), "utf8"), before);
});

test("fix CLI writes output patch artifact through policy", () => {
  const root = copyFixture("node-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--test",
    "npm test",
    "--output-patch",
    "fixes/generated.patch",
    "--dry-run",
    "--json"
  ]);

  assert.equal(result.status, "dry_run");
  assert.equal(result.outputPatch.path, "fixes/generated.patch");
  assert.equal(result.outputPatch.policy.status, "allow");
  assert.match(fs.readFileSync(path.join(root, "fixes", "generated.patch"), "utf8"), /user\.firstName/);
});

test("fix CLI blocks output patch artifact on denied path", () => {
  const root = copyFixture("node-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--output-patch",
    ".env",
    "--dry-run",
    "--json"
  ], { allowFailure: true });

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "output_patch");
  assert.equal(result.outputPatch.policy.status, "deny");
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
});

test("fix CLI returns branch commit PR dry-run plan", () => {
  const root = copyFixture("node-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--create-branch",
    "--commit",
    "--pr-dry-run",
    "--pr-body-file",
    "patches/pr-body.md",
    "--dry-run",
    "--json"
  ]);

  assert.equal(result.status, "dry_run");
  assert.equal(result.gitPlan.status, "dry_run");
  assert.equal(result.gitPlan.branch, "codex/fix-referenceerror");
  assert.deepEqual(result.gitPlan.changedFiles, ["src/user.js"]);
  assert.deepEqual(result.gitPlan.commands.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "create_pr"
  ]);
  assert.ok(result.gitPlan.commands.at(-1).argv.includes("--body-file"));
});

test("fix CLI blocks git plan execution without confirmation before patch apply", () => {
  const root = copyFixture("node-bug");
  const before = fs.readFileSync(path.join(root, "src", "user.js"), "utf8");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--create-branch",
    "--commit",
    "--execute-git-plan",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "require_confirmation");
  assert.equal(result.stage, "git_plan_policy");
  assert.equal(result.gitPolicy.status, "require_confirmation");
  assert.equal(fs.readFileSync(path.join(root, "src", "user.js"), "utf8"), before);
});

test("fix CLI executes confirmed local branch and commit plan after patch apply", () => {
  const root = copyFixture("node-bug");
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, encoding: "utf8" });
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--create-branch",
    "--commit",
    "--execute-git-plan",
    "--confirm",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.gitExecution.status, "executed");
  assert.deepEqual(result.gitExecution.results.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit"
  ]);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "codex/fix-referenceerror");
  assert.equal(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, encoding: "utf8" }).trim(), "fix: address ReferenceError");
});

test("fix CLI executes confirmed push plan against local bare remote", () => {
  const root = copyFixture("node-bug");
  const remote = tempDir("vibeguard-remote-");
  execFileSync("git", ["init", "--bare"], { cwd: remote, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, encoding: "utf8" });

  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--create-branch",
    "--commit",
    "--push",
    "--execute-git-plan",
    "--confirm",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.gitExecution.status, "executed");
  assert.deepEqual(result.gitExecution.results.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "push_branch"
  ]);
  const pushedRef = execFileSync("git", ["--git-dir", remote, "show-ref", "refs/heads/codex/fix-referenceerror"], {
    encoding: "utf8"
  });
  assert.match(pushedRef, /refs\/heads\/codex\/fix-referenceerror/);
});

test("fix CLI applies Node fixture patch and runs tests", () => {
  const root = copyFixture("node-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--test",
    "npm test",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.applyResult.status, "applied");
  assert.equal(result.tests.status, "passed");
  assert.match(fs.readFileSync(path.join(root, "src", "user.js"), "utf8"), /user\.firstName/);
});

test("fix CLI auto-test runs the first suggested test command", () => {
  const root = copyFixture("node-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--auto-test",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.selectedTestCommand, "npm test");
  assert.equal(result.decision.selectedTestCommand, "npm test");
  assert.equal(result.tests.status, "passed");
});
