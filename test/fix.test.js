import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PolicyEngine } from "../src/policy/engine.js";
import { runFixWorkflow } from "../src/agents/fix.js";
import { validateUnifiedDiff } from "../src/patch/validatePatch.js";

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

function runCli(args) {
  const output = execFileSync(process.execPath, [bin, ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  return JSON.parse(output);
}

test("validateUnifiedDiff rejects empty and non-diff patch text", () => {
  assert.equal(validateUnifiedDiff("").valid, false);
  assert.equal(validateUnifiedDiff("change src/app.js").valid, false);
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
