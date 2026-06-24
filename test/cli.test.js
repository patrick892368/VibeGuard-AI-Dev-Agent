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

  const output = execFileSync(process.execPath, [bin, "--root", root, "test", "--coverage", "coverage.json", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.coverage.format, "coverage.py-json");
  assert.equal(parsed.candidates[0].coverage.missingLineCount, 1);
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
