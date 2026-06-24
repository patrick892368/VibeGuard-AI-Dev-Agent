import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PolicyEngine } from "../src/policy/engine.js";
import { readFileWithPolicy, writeFileWithPolicy } from "../src/policy/safeWrite.js";
import { writeSuggestedTests } from "../src/agents/testWriter.js";
import { writeOnboardingDocs } from "../src/agents/onboard.js";
import { applyPatchWithPolicy } from "../src/patch/safeApply.js";
import { commandDisplay, runArgvWithPolicy, runCommandWithPolicy } from "../src/runner/safeCommand.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-write-"));
}

function engineFor(root) {
  return new PolicyEngine({
    paths: {
      allow: ["src/**", "test/**", "tests/**", "docs/**", "reports/**", "README.md"],
      deny: [".env", ".git/**"],
      require_confirmation: ["package-lock.json"]
    },
    commands: { deny: [], require_confirmation: [] }
  }, { root });
}

test("writeFileWithPolicy writes allowed files and blocks denied files", () => {
  const root = tempRepo();
  const engine = engineFor(root);

  const result = writeFileWithPolicy(root, "docs/NOTE.md", "hello", engine);
  assert.equal(result.policy.status, "allow");
  assert.equal(fs.readFileSync(path.join(root, "docs", "NOTE.md"), "utf8"), "hello");
  assert.throws(() => writeFileWithPolicy(root, ".env", "SECRET=1", engine), /deny policy/);
});

test("policy-gated file operations reject paths outside the repository root", () => {
  const root = tempRepo();
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: [], require_confirmation: [] }
  }, { root });

  assert.throws(() => writeFileWithPolicy(root, "../escape.txt", "nope", engine), /escapes repository root/);
  assert.throws(() => readFileWithPolicy(root, "../escape.txt", engine), /escapes repository root/);
});

test("policy-gated operations can append audit JSONL events", () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "old\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], { cwd: root, encoding: "utf8" });
  const engine = engineFor(root);
  const auditLog = "reports/audit.jsonl";

  writeFileWithPolicy(root, "docs/NOTE.md", "hello", engine, { auditLog });
  runCommandWithPolicy(root, "node --version", engine, { dryRun: true, auditLog });
  applyPatchWithPolicy(root, `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`, engine, { checkOnly: true, auditLog });

  const events = fs.readFileSync(path.join(root, auditLog), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.operation), ["write_file", "run_command", "check_patch", "check_patch_result"]);
  assert.equal(events[0].policyStatus, "allow");
  assert.equal(events[1].dryRun, true);
  assert.deepEqual(events[2].files, ["src/app.js"]);
});

test("writeSuggestedTests writes a real JavaScript smoke test through policy", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  assert.equal(result.written.length, 1);
  assert.equal(result.written[0].path, "src/math.test.js");
  const generated = fs.readFileSync(path.join(root, "src", "math.test.js"), "utf8");
  assert.match(generated, /exports expected functions/);
  assert.match(generated, /assert\.equal\(mod\.add\(2, 3\), 5\)/);
});

test("writeSuggestedTests focuses generated assertions on uncovered functions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), `export function covered() {
  return true;
}

export function uncovered() {
  return false;
}
`, "utf8");
  const coveragePath = path.join(root, "coverage.json");
  fs.writeFileSync(coveragePath, JSON.stringify({
    files: {
      "src/math.js": {
        missing_lines: [6],
        summary: { percent_covered: 50 }
      }
    }
  }), "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, coverageFile: coveragePath });
  const generated = fs.readFileSync(path.join(root, "src", "math.test.js"), "utf8");
  assert.equal(result.coverageTargets[0].sourceFile, "src/math.js");
  assert.deepEqual(result.coverageTargets[0].uncoveredFunctions, ["uncovered"]);
  assert.doesNotMatch(generated, /typeof mod\.covered/);
  assert.doesNotMatch(generated, /mod\.covered\(\)/);
  assert.match(generated, /typeof mod\.uncovered/);
  assert.match(generated, /assert\.equal\(mod\.uncovered\(\), false\)/);
});

test("writeSuggestedTests writes simple Python behavior assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.py"), `def add(a, b):
    return a + b
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  const generated = fs.readFileSync(path.join(root, "tests", "test_math.py"), "utf8");
  assert.equal(result.written.length, 1);
  assert.match(generated, /class GeneratedBehaviorTest\(unittest\.TestCase\)/);
  assert.match(generated, /self\.assertEqual\(module\.add\(2, 3\), 5\)/);
});

test("writeSuggestedTests writes simple JavaScript branch assertions", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "user.js"), `export function normalizeName(name) {
  if (name == null) {
    return "unknown";
  }
  return name.trim().toLowerCase();
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "user.test.js"), "utf8");
  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /assert\.equal\(mod\.normalizeName\(null\), "unknown"\)/);
  assert.match(generated, /assert\.equal\(mod\.normalizeName\(" Ada "\), "ada"\)/);
});

test("writeSuggestedTests writes simple Python branch assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "user.py"), `def display_name(name):
    if name is None:
        return "unknown"
    return name.strip()
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  const generated = fs.readFileSync(path.join(root, "tests", "test_user.py"), "utf8");
  assert.equal(result.written.length, 1);
  assert.match(generated, /self\.assertEqual\(module\.display_name\(None\), "unknown"\)/);
  assert.match(generated, /self\.assertEqual\(module\.display_name\(" Ada "\), "Ada"\)/);
});

test("writeSuggestedTests writes JavaScript numeric boundary assertions", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "score.js"), `export function normalizeScore(value) {
  if (value <= 0) {
    return 0;
  }
  return value;
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "score.test.js"), "utf8");
  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /assert\.equal\(mod\.normalizeScore\(-2\), 0\)/);
  assert.match(generated, /assert\.equal\(mod\.normalizeScore\(0\), 0\)/);
  assert.match(generated, /assert\.equal\(mod\.normalizeScore\(3\), 3\)/);
});

test("writeSuggestedTests writes Python empty collection branch assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "items.py"), `def first_item(items):
    if len(items) == 0:
        return None
    return items[0]
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  const generated = fs.readFileSync(path.join(root, "tests", "test_items.py"), "utf8");
  assert.equal(result.written.length, 1);
  assert.match(generated, /self\.assertEqual\(module\.first_item\(\[\]\), None\)/);
  assert.match(generated, /self\.assertEqual\(module\.first_item\(\["Ada"\]\), "Ada"\)/);
});

test("writeSuggestedTests writes simple JavaScript exception assertions", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "number.js"), `export function requirePositive(value) {
  if (value < 0) {
    throw new RangeError("negative");
  }
  return value;
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "number.test.js"), "utf8");
  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /assert\.throws\(\(\) => mod\.requirePositive\(-2\), RangeError\)/);
});

test("writeSuggestedTests writes simple Python exception assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "number.py"), `def require_positive(value):
    if value < 0:
        raise ValueError("negative")
    return value
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  const generated = fs.readFileSync(path.join(root, "tests", "test_number.py"), "utf8");
  assert.equal(result.written.length, 1);
  assert.match(generated, /module\.require_positive\(-2\)/);
  assert.match(generated, /with self\.assertRaises\(ValueError\)/);
});

test("writeSuggestedTests can run a generated Python unittest through policy", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.py"), `def add(a, b):
    return a + b
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  assert.equal(result.written.length, 1);
  assert.equal(result.testRuns.length, 1);
  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.testRuns[0].command, "python -m unittest tests/test_math.py");
});

test("writeSuggestedTests can prepare a Git and PR dry-run plan", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: [], require_confirmation: [] },
    commands: {
      deny: [],
      require_confirmation: ["git switch -c", "git commit", "gh pr create"]
    }
  }, { root });

  const result = writeSuggestedTests(root, engine, {
    limit: 1,
    createBranch: true,
    commit: true,
    prDryRun: true
  });

  assert.equal(result.written.length, 1);
  assert.equal(result.gitPlan.status, "dry_run");
  assert.equal(result.gitPlan.branch, "codex/add-generated-tests");
  assert.deepEqual(result.gitPlan.changedFiles, ["src/math.test.js"]);
  assert.deepEqual(result.gitPlan.commands.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "create_pr"
  ]);
  assert.equal(result.gitPolicy.status, "require_confirmation");
  assert.ok(result.gitPlan.commands.at(-1).argv.includes("--body"));
});

test("writeSuggestedTests can run a generated JavaScript test through policy", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  assert.equal(result.written.length, 1);
  assert.equal(result.testRuns.length, 1);
  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.testRuns[0].command, "node --test src/math.test.js");
});

test("writeSuggestedTests can run a generated CommonJS test through policy", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), `function add(a, b) {
  return a + b;
}

module.exports = { add };
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "math.test.js"), "utf8");
  assert.deepEqual(result.candidates[0].functions, ["add"]);
  assert.equal(result.candidates[0].metadata.moduleSystem, "commonjs");
  assert.match(generated, /require\("node:test"\)/);
  assert.match(generated, /assert\.equal\(mod\.add\(2, 3\), 5\)/);
  assert.equal(result.testRuns[0].status, "passed");
});

test("writeSuggestedTests classifies failed generated test runs", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, {
    limit: 1,
    runTests: true,
    testCommand: "node missing-runner.js"
  });
  assert.equal(result.testRuns[0].status, "failed");
  assert.equal(result.testRuns[0].failureAnalysis.category, "missing_module_or_bad_import");
  assert.match(result.testRuns[0].failureAnalysis.nextAction, /import path|test dependencies/);
  assert.equal(result.testRuns[0].failureAnalysis.repairPlan.status, "needs_repair");
  assert.equal(result.testRuns[0].failureAnalysis.repairPlan.safeToAutoRetry, false);
  assert.match(result.testRuns[0].failureAnalysis.repairPlan.actions.join("\n"), /relative import path|dependencies/);
  assert.match(result.testRuns[0].failureAnalysis.repairPlan.guardrails.join("\n"), /Do not delete assertions/);
});

test("writeSuggestedTests returns a repair plan for assertion failures", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, {
    limit: 1,
    runTests: true,
    testCommand: "node -e \"throw new Error('AssertionError: mismatch')\""
  });
  assert.equal(result.testRuns[0].status, "failed");
  assert.equal(result.testRuns[0].failureAnalysis.category, "assertion_failed");
  assert.match(result.testRuns[0].failureAnalysis.evidence, /AssertionError/);
  assert.equal(result.testRuns[0].failureAnalysis.repairPlan.safeToAutoRetry, false);
  assert.match(result.testRuns[0].failureAnalysis.repairPlan.actions.join("\n"), /fix the source bug|stronger correct assertion/);
});

test("writeOnboardingDocs writes onboarding and architecture docs through policy", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n", "utf8");
  const engine = engineFor(root);

  const result = writeOnboardingDocs(root, engine);
  assert.equal(result.written.length, 2);
  assert.ok(fs.existsSync(path.join(root, "docs", "ONBOARDING.md")));
  assert.ok(fs.existsSync(path.join(root, "docs", "ARCHITECTURE.md")));
});

test("applyPatchWithPolicy supports check-only patch validation", () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "old\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], { cwd: root, encoding: "utf8" });

  const patch = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;
  const engine = engineFor(root);
  const result = applyPatchWithPolicy(root, patch, engine, { checkOnly: true });
  assert.equal(result.status, "checked");
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "old\n");
});

test("runCommandWithPolicy checks command policy before execution", () => {
  const root = tempRepo();
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: ["rm -rf"], require_confirmation: ["npm install"] }
  }, { root });

  const dryRun = runCommandWithPolicy(root, "node --version", engine, { dryRun: true });
  assert.equal(dryRun.status, "checked");
  assert.throws(() => runCommandWithPolicy(root, "rm -rf .", engine, { dryRun: true }), /deny policy/);
  assert.throws(() => runCommandWithPolicy(root, "npm install", engine, { dryRun: true }), /requires human confirmation/);

  const confirmed = runCommandWithPolicy(root, "npm install", engine, { dryRun: true, confirmed: true });
  assert.equal(confirmed.status, "checked");
});

test("runArgvWithPolicy checks command policy and keeps argv structured", () => {
  const root = tempRepo();
  const engine = new PolicyEngine({
    paths: { allow: ["**"], deny: [], require_confirmation: [] },
    commands: { deny: ["bad command"], require_confirmation: ["node --version"] }
  }, { root });

  assert.equal(commandDisplay(["git", "commit", "-m", "fix bug"]), 'git commit -m "fix bug"');
  assert.throws(() => runArgvWithPolicy(root, ["node", "--version"], engine, { dryRun: true }), /requires human confirmation/);

  const result = runArgvWithPolicy(root, ["node", "--version"], engine, {
    dryRun: true,
    confirmed: true
  });
  assert.equal(result.status, "checked");
  assert.deepEqual(result.argv, ["node", "--version"]);
});
