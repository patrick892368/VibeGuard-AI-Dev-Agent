import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PolicyEngine } from "../src/policy/engine.js";
import { readFileWithPolicy, writeFileWithPolicy } from "../src/policy/safeWrite.js";
import { writeSuggestedTests, writeSuggestedTestsAsync } from "../src/agents/testWriter.js";
import { writeOnboardingDocs } from "../src/agents/onboard.js";
import { applyPatchWithPolicy } from "../src/patch/safeApply.js";
import { commandDisplay, runArgvWithPolicy, runCommandWithPolicy } from "../src/runner/safeCommand.js";

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-write-"));
}

function engineFor(root) {
  return new PolicyEngine({
    paths: {
      allow: ["src/**", "test/**", "tests/**", "docs/**", "reports/**", "coverage*.json", "coverage/**", "README.md"],
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
  assert.deepEqual(events.map((event) => event.operation), [
    "write_file",
    "run_command",
    "check_patch",
    "run_command",
    "run_command_result",
    "check_patch_result"
  ]);
  assert.equal(events[0].policyStatus, "allow");
  assert.equal(events[1].dryRun, true);
  assert.deepEqual(events[2].files, ["src/app.js"]);
  assert.equal(events[3].command, "git apply --check");
  assert.equal(events[3].policyStatus, "allow");
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

test("writeSuggestedTests writes JavaScript class smoke assertions", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "user.js"), `export class User {
  constructor(name) {
    this.name = name;
  }
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  const generated = fs.readFileSync(path.join(root, "src", "user.test.js"), "utf8");
  assert.deepEqual(result.candidates[0].classes, ["User"]);
  assert.match(generated, /assert\.equal\(typeof mod\.User, "function"\)/);
});

test("writeSuggestedTests runs JavaScript default class smoke assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "user.mjs"), `export default class User {
  constructor(name) {
    this.name = name;
  }
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "user.test.mjs"), "utf8");
  assert.deepEqual(result.candidates[0].classes, ["User"]);
  assert.match(generated, /typeof \(mod\.User \|\| mod\.default\)/);
  assert.equal(result.testRuns[0].status, "passed");
});

test("writeSuggestedTests writes Python class smoke assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "user.py"), `class User:
    def __init__(self, name):
        self.name = name
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  const generated = fs.readFileSync(path.join(root, "tests", "test_user.py"), "utf8");
  assert.deepEqual(result.candidates[0].classes, ["User"]);
  assert.match(generated, /self\.assertTrue\(hasattr\(module, "User"\)\)/);
});

test("writeSuggestedTests skips runtime writes for TypeScript interface-only files", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "types.ts"), `export interface User {
  id: string;
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1 });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].interfaces, ["User"]);
  assert.equal(result.written.length, 0);
  assert.equal(fs.existsSync(path.join(root, "src", "types.test.ts")), false);
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

test("writeSuggestedTests writes async JavaScript behavior assertions", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "asyncMath.js"), `export async function add(a, b) {
  return a + b;
}

export const normalize = async (name) => name.trim().toLowerCase();
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "asyncMath.test.js"), "utf8");

  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /test\("covers simple behavior", async \(\) => \{/);
  assert.match(generated, /assert\.equal\(await mod\.add\(2, 3\), 5\)/);
  assert.match(generated, /assert\.equal\(await mod\.normalize\(" Ada "\), "ada"\)/);
});

test("writeSuggestedTests writes CommonJS async export assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "service.js"), `exports.add = async function (a, b) {
  return a + b;
}

module.exports["normalize"] = async (name) => name.trim();
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "service.test.js"), "utf8");

  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /const mod = require\("\.\/service\.js"\)/);
  assert.match(generated, /test\("covers simple behavior", async \(\) => \{/);
  assert.match(generated, /assert\.equal\(await mod\.add\(2, 3\), 5\)/);
  assert.match(generated, /assert\.equal\(await mod\.normalize\(" Ada "\), "Ada"\)/);
});

test("writeSuggestedTests writes JavaScript collection behavior assertions", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "users.js"), `export function names(users) {
  return users.map((user) => user.name);
}

export function activeUsers(users) {
  return users.filter((user) => user.active);
}

export async function ids(users) {
  return Promise.resolve(users.map((user) => user.id));
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "users.test.js"), "utf8");

  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /assert\.deepEqual\(mod\.names\(\[\{"name":"Ada"\},\{"name":"Grace"\}\]\), \["Ada","Grace"\]\)/);
  assert.match(generated, /assert\.deepEqual\(mod\.activeUsers\(\[\{"active":true\},\{"active":false\}\]\), \[\{"active":true\}\]\)/);
  assert.match(generated, /assert\.deepEqual\(await mod\.ids\(\[\{"id":123\},\{"id":456\}\]\), \[123,456\]\)/);
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

test("writeSuggestedTests writes JavaScript object property branch assertions", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "user.js"), `export function displayName(user) {
  if (user == null) {
    return "unknown";
  }
  return user.name;
}
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "src", "user.test.js"), "utf8");
  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /assert\.equal\(mod\.displayName\(null\), "unknown"\)/);
  assert.match(generated, /assert\.equal\(mod\.displayName\(\{"name":"Ada"\}\), "Ada"\)/);
});

test("writeSuggestedTests writes Python dictionary field branch assertions", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "user.py"), `def display_name(user):
    if user is None:
        return "unknown"
    return user["name"]
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, { limit: 1, runTests: true });
  const generated = fs.readFileSync(path.join(root, "tests", "test_user.py"), "utf8");
  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /self\.assertEqual\(module\.display_name\(None\), "unknown"\)/);
  assert.match(generated, /self\.assertEqual\(module\.display_name\(\{"name":"Ada"\}\), "Ada"\)/);
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

test("writeSuggestedTests can repair Python local import path failures", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "helper.py"), "VALUE = 'Ada'\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "greeting.py"), `from helper import VALUE

def greeting():
    return VALUE
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, {
    limit: 1,
    runTests: true,
    repairFailures: true
  });
  const generated = fs.readFileSync(path.join(root, "tests", "test_greeting.py"), "utf8");

  assert.equal(result.initialTestRuns[0].status, "failed");
  assert.equal(result.initialTestRuns[0].failureAnalysis.category, "python_local_import_path");
  assert.equal(result.initialTestRuns[0].failureAnalysis.repairPlan.safeToAutoRetry, true);
  assert.equal(result.repairRuns[0].status, "repaired");
  assert.equal(result.repairRuns[0].strategy, "python_source_dir_sys_path");
  assert.equal(result.repairRuns[0].written.policy.status, "allow");
  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.testRuns[0].repaired, true);
  assert.match(generated, /sys\.path\.insert\(0, source_dir\)/);
});

test("writeSuggestedTests detects JavaScript bracket CommonJS exports", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), `function add(a, b) {
  return a + b;
}

exports["add"] = add;
`, "utf8");
  const engine = engineFor(root);

  const result = writeSuggestedTests(root, engine, {
    limit: 1,
    runTests: true,
    repairFailures: true
  });
  const generated = fs.readFileSync(path.join(root, "src", "math.test.js"), "utf8");

  assert.equal(result.candidates[0].metadata.moduleSystem, "commonjs");
  assert.equal(result.initialTestRuns, undefined);
  assert.equal(result.repairRuns, undefined);
  assert.equal(result.testRuns[0].status, "passed");
  assert.match(generated, /const mod = require\("\.\/math\.js"\)/);
  assert.match(generated, /assert\.equal\(mod\.add\(2, 3\), 5\)/);
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
  assert.equal(result.gitPlan.branch, "codex/add-tests-math");
  assert.equal(result.gitPlan.commitMessage, "test: add generated tests for math");
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

test("writeSuggestedTests blocks git plan execution without confirmation", () => {
  const root = tempRepo();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: [], require_confirmation: [] },
    commands: {
      deny: [],
      require_confirmation: ["git switch -c", "git commit"]
    }
  }, { root });

  const result = writeSuggestedTests(root, engine, {
    limit: 1,
    runTests: true,
    createBranch: true,
    commit: true,
    executeGitPlan: true
  });

  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.gitPolicy.status, "require_confirmation");
  assert.equal(result.gitExecution.status, "require_confirmation");
  assert.equal(result.gitExecution.stage, "git_plan_policy");
  assert.deepEqual(result.gitExecution.results, []);
});

test("writeSuggestedTests executes confirmed local branch and commit plan after tests pass", () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, encoding: "utf8" });

  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: [".git/**"], require_confirmation: [] },
    commands: {
      deny: [],
      require_confirmation: ["git switch -c", "git commit"]
    }
  }, { root });

  const result = writeSuggestedTests(root, engine, {
    limit: 1,
    runTests: true,
    createBranch: true,
    commit: true,
    executeGitPlan: true,
    confirmed: true
  });

  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.gitPolicy.status, "allow");
  assert.equal(result.gitExecution.status, "executed");
  assert.deepEqual(result.gitExecution.results.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit"
  ]);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), "codex/add-tests-math");
  assert.equal(execFileSync("git", ["log", "-1", "--pretty=%s"], { cwd: root, encoding: "utf8" }).trim(), "test: add generated tests for math");
});

test("writeSuggestedTestsAsync can create test PRs through the GitHub REST fallback", async () => {
  const root = tempRepo();
  execFileSync("git", ["init"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: root, encoding: "utf8" });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) { return a + b; }\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, encoding: "utf8" });

  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: [".git/**"], require_confirmation: [] },
    commands: {
      deny: [],
      require_confirmation: ["git switch -c", "git commit", "gh pr create"]
    }
  }, { root });
  let request;

  const result = await writeSuggestedTestsAsync(root, engine, {
    limit: 1,
    runTests: true,
    createBranch: true,
    commit: true,
    createPr: true,
    executeGitPlan: true,
    confirmed: true,
    githubUseApi: true,
    env: { GITHUB_TOKEN: "token" },
    async githubFetch(url, options) {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 201,
        async json() {
          return { html_url: "https://github.com/owner/repo/pull/8", number: 8 };
        }
      };
    }
  });

  assert.equal(result.testRuns[0].status, "passed");
  assert.equal(result.gitExecution.status, "executed");
  assert.deepEqual(result.gitExecution.results.map((command) => command.step), [
    "create_branch",
    "stage_files",
    "commit",
    "create_pr"
  ]);
  assert.equal(result.gitExecution.results.at(-1).method, "api");
  assert.equal(result.gitExecution.results.at(-1).url, "https://github.com/owner/repo/pull/8");
  assert.equal(request.url, "https://api.github.com/repos/owner/repo/pulls");
  assert.equal(request.body.head, "codex/add-tests-math");
  assert.equal(request.body.title, "Add generated tests for math");
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
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.js"), "export function run() {}\n", "utf8");
  const engine = engineFor(root);

  const result = writeOnboardingDocs(root, engine);
  assert.equal(result.written.length, 2);
  assert.ok(fs.existsSync(path.join(root, "docs", "ONBOARDING.md")));
  assert.ok(fs.existsSync(path.join(root, "docs", "ARCHITECTURE.md")));
  assert.match(fs.readFileSync(path.join(root, "docs", "ONBOARDING.md"), "utf8"), /Core Modules/);
  assert.match(fs.readFileSync(path.join(root, "docs", "ARCHITECTURE.md"), "utf8"), /src \/ entrypoint/);
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
  assert.equal(result.applyCheckCommand.command, "git apply --check");
  assert.equal(result.applyCheckCommand.policy.status, "allow");
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "old\n");
});

test("applyPatchWithPolicy checks git apply command policy", () => {
  const root = tempRepo();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.js"), "old\n", "utf8");
  const patch = `diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1 +1 @@
-old
+new
`;
  const engine = new PolicyEngine({
    paths: { allow: ["src/**"], deny: [], require_confirmation: [] },
    commands: { deny: ["git apply"], require_confirmation: [] }
  }, { root });

  assert.throws(() => applyPatchWithPolicy(root, patch, engine, { checkOnly: true }), /Command matches deny policy: git apply/);
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
