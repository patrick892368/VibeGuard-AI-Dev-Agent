import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PolicyEngine } from "../src/policy/engine.js";
import { runFixWorkflow } from "../src/agents/fix.js";
import { generateFallbackPatch } from "../src/agents/fallbackPatch.js";
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

test("normalizeUnifiedDiff adds a git header to plain unified diffs", () => {
  const patch = `--- a/accounts/views.py
+++ b/accounts/views.py
@@ -1,2 +1,2 @@
-PROFILE_TEMPLATE = "profiles/detail.html"
+PROFILE_TEMPLATE = "accounts/detail.html"
`;

  const normalized = normalizeUnifiedDiff(patch);
  assert.match(normalized, /^diff --git a\/accounts\/views\.py b\/accounts\/views\.py/);
  assert.equal(validateUnifiedDiff(normalized).valid, true);
});

test("normalizeUnifiedDiff repairs non-git diff headers", () => {
  const patch = `diff a/accounts/views.py b/accounts/views.py
--- a/accounts/views.py
+++ b/accounts/views.py
@@ -1,2 +1,2 @@
-PROFILE_TEMPLATE = "profiles/detail.html"
+PROFILE_TEMPLATE = "accounts/detail.html"
`;

  const normalized = normalizeUnifiedDiff(patch);
  assert.match(normalized, /^diff --git a\/accounts\/views\.py b\/accounts\/views\.py/);
  assert.equal(normalized.includes("\ndiff a/accounts/views.py b/accounts/views.py"), false);
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

test("fallback patch recovery skips denied source files", () => {
  const root = tempDir("vibeguard-fallback-policy-");
  fs.mkdirSync(path.join(root, "secret"), { recursive: true });
  fs.mkdirSync(path.join(root, "templates", "accounts"), { recursive: true });
  fs.writeFileSync(path.join(root, "secret", "views.py"), "PROFILE_TEMPLATE = \"profiles/detail.html\"\n", "utf8");
  fs.writeFileSync(path.join(root, "templates", "accounts", "detail.html"), "<h1>profile</h1>\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: ["secret/**"], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  const result = generateFallbackPatch({
    summary: {
      type: "django.template.exceptions.TemplateDoesNotExist",
      message: "profiles/detail.html"
    },
    frames: [{ file: "secret/views.py", line: 1 }],
    likelyFiles: ["secret/views.py"]
  }, {
    root,
    engine
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.patch, undefined);
  assert.equal(result.skippedSourceFiles[0].file, "secret/views.py");
  assert.equal(result.skippedSourceFiles[0].policy.status, "deny");
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

test("fix CLI blocks denied log input files", () => {
  const root = copyFixture("node-bug");
  fs.writeFileSync(path.join(root, ".env"), "ReferenceError: secret_log should not be read", "utf8");

  assert.throws(() => execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "fix",
    "--log",
    ".env",
    "--patch",
    "fixes/reference-error.patch",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  }), /Path matches deny policy/);
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

test("fix CLI blocks denied patch input files", () => {
  const root = copyFixture("node-bug");
  fs.writeFileSync(path.join(root, ".env"), `diff --git a/src/user.js b/src/user.js
--- a/src/user.js
+++ b/src/user.js
@@ -1 +1 @@
-old
+new
`, "utf8");

  assert.throws(() => execFileSync(process.execPath, [
    bin,
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    ".env",
    "--json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  }), /Path matches deny policy/);
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
    "fixes/pr-body.md",
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
  assert.equal(result.gitPolicy.status, "require_confirmation");
  assert.equal(result.gitPolicy.pathResults[0].path, "fixes/pr-body.md");
});

test("fix CLI dry-run surfaces denied PR body-file policy", () => {
  const root = copyFixture("node-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/reference-error.patch",
    "--create-pr",
    "--pr-body-file",
    ".env",
    "--dry-run",
    "--json"
  ]);

  assert.equal(result.status, "dry_run");
  assert.equal(result.gitPolicy.status, "deny");
  assert.equal(result.gitPolicy.pathResults[0].path, ".env");
  assert.equal(result.decision.gitPolicyStatus, "deny");
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

test("fix workflow can create PRs through the GitHub REST fallback", async () => {
  const root = copyFixture("node-bug");
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, encoding: "utf8" });
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [".env"], require_confirmation: [] },
    commands: {
      deny: [],
      require_confirmation: ["git switch -c", "git commit", "gh pr create"]
    }
  }, { root });
  const requests = [];

  const result = await runFixWorkflow({
    root,
    engine,
    logFile: "error.log",
    patchFile: "fixes/reference-error.patch",
    testCommand: "npm test",
    apply: true,
    createBranch: true,
    commit: true,
    createPr: true,
    executeGitPlan: true,
    confirmed: true,
    env: { GITHUB_TOKEN: "token" },
    githubUseApi: true,
    checkCi: true,
    ciLimit: 4,
    async githubFetch(url, options) {
      const request = { url, options, body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      if (url.includes("/actions/runs?")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workflow_runs: [{
                id: 222,
                status: "completed",
                conclusion: "success",
                name: "CI",
                head_branch: "codex/fix-referenceerror",
                event: "pull_request",
                workflow_name: "CI",
                html_url: "https://github.com/owner/repo/actions/runs/222"
              }]
            };
          }
        };
      }
      return {
        ok: true,
        status: 201,
        async json() {
          return { html_url: "https://github.com/owner/repo/pull/1", number: 1 };
        }
      };
    }
  });

  assert.equal(result.status, "passed");
  assert.equal(result.gitExecution.status, "executed");
  assert.equal(result.gitExecution.results.at(-1).step, "create_pr");
  assert.equal(result.gitExecution.results.at(-1).method, "api");
  assert.equal(result.gitExecution.results.at(-1).url, "https://github.com/owner/repo/pull/1");
  assert.equal(requests[0].url, "https://api.github.com/repos/owner/repo/pulls");
  assert.equal(requests[0].body.head, "codex/fix-referenceerror");
  assert.match(requests[1].url, /\/actions\/runs\?per_page=4&branch=codex%2Ffix-referenceerror$/);
  assert.equal(result.gitExecution.ciStatus.status, "completed");
  assert.equal(result.gitExecution.ciStatus.summary.gate, "pass");
  assert.equal(result.ciStatus.summary.gate, "pass");
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

test("fix CLI auto-test prioritizes the stack trace test file for Node", () => {
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
  assert.equal(result.selectedTestCommand, "node --test tests/user.case.js");
  assert.equal(result.decision.selectedTestCommand, "node --test tests/user.case.js");
  assert.equal(result.tests.status, "passed");
});

test("fix CLI auto-test prioritizes the traceback test file for Python", () => {
  const root = copyFixture("python-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/name-error.patch",
    "--auto-test",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.selectedTestCommand, "python -m unittest tests/test_greeter.py");
  assert.equal(result.tests.status, "passed");
});

test("fix CLI applies Django-style fixture patch and runs traceback test", () => {
  const root = copyFixture("django-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/template-error.patch",
    "--auto-test",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.debug.frameworkContext.framework, "Django");
  assert.ok(result.debug.hints.some((hint) => hint.includes("TemplateDoesNotExist")));
  assert.equal(result.selectedTestCommand, "python -m unittest tests/test_views.py");
  assert.equal(result.tests.status, "passed");
  assert.match(fs.readFileSync(path.join(root, "accounts", "views.py"), "utf8"), /accounts\/detail\.html/);
});

test("fix CLI applies Spring Boot-style fixture patch and runs focused smoke test", () => {
  const root = copyFixture("spring-boot-bug");
  const result = runCli([
    "--root",
    root,
    "fix",
    "--log",
    "error.log",
    "--patch",
    "fixes/service-annotation.patch",
    "--auto-test",
    "--apply",
    "--json"
  ]);

  assert.equal(result.status, "passed");
  assert.equal(result.debug.frameworkContext.framework, "Spring Boot");
  assert.ok(result.debug.hints.some((hint) => hint.includes("dependency injection")));
  assert.equal(result.selectedTestCommand, "node --test tests/UserService.test.js");
  assert.equal(result.tests.status, "passed");
  assert.match(fs.readFileSync(path.join(root, "src", "main", "java", "com", "example", "UserService.java"), "utf8"), /@Service/);
});
