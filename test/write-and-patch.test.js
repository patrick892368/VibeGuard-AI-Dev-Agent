import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PolicyEngine } from "../src/policy/engine.js";
import { writeFileWithPolicy } from "../src/policy/safeWrite.js";
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
  assert.match(fs.readFileSync(path.join(root, "src", "math.test.js"), "utf8"), /exports expected functions/);
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
  assert.match(generated, /typeof mod\.uncovered/);
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
  assert.equal(result.testRuns[0].status, "passed");
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
