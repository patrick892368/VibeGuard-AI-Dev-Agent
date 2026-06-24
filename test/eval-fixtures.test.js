import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { evaluateFixFixtures } from "../src/eval/fixtures.js";

const bin = path.resolve("bin/vibeguard.js");

function fixturePatchMap() {
  return JSON.stringify({
    NameError: fs.readFileSync(path.resolve("fixtures/python-bug/fixes/name-error.patch"), "utf8"),
    ReferenceError: fs.readFileSync(path.resolve("fixtures/node-bug/fixes/reference-error.patch"), "utf8")
  });
}

function copyRepoWithoutSecrets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-eval-output-"));
  fs.cpSync(path.resolve("."), root, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) &&
      !source.endsWith(`${path.sep}.git`) &&
      !source.endsWith(`${path.sep}.env`)
  });
  return root;
}

test("evaluateFixFixtures records blocked results when provider is not configured", async () => {
  const result = await evaluateFixFixtures({
    root: process.cwd(),
    env: {}
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider, "unset");
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.counts.blocked, 2);
  assert.equal(result.summary.successRate, 0);
  assert.ok(result.results.every((item) => item.patchSourceStatus === "unavailable"));
});

test("evaluateFixFixtures passes both fixtures with fixture provider patch map", async () => {
  const result = await evaluateFixFixtures({
    root: process.cwd(),
    env: {
      VIBEGUARD_LLM_PROVIDER: "fixture",
      VIBEGUARD_FIXTURE_PATCH_MAP: fixturePatchMap()
    }
  });

  assert.equal(result.provider, "fixture");
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.counts.passed, 2);
  assert.equal(result.summary.successRate, 1);
  assert.deepEqual(result.results.map((item) => item.outcome), ["passed", "passed"]);
  assert.ok(result.results.every((item) => item.policyStatus === "allow"));
});

test("CLI eval fixtures supports selecting one fixture", () => {
  const output = execFileSync(process.execPath, [bin, "eval", "fixtures", "--fixture", "node-bug", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_LLM_PROVIDER: "fixture",
      VIBEGUARD_FIXTURE_PATCH_MAP: fixturePatchMap()
    }
  });
  const result = JSON.parse(output);

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.counts.passed, 1);
  assert.equal(result.results[0].id, "node-bug");
});

test("CLI eval fixtures writes report output through policy", () => {
  const root = copyRepoWithoutSecrets();
  const outputPath = "reports/eval-fixtures.json";

  const output = execFileSync(process.execPath, [path.join(root, "bin", "vibeguard.js"), "--root", root, "eval", "fixtures", "--output", outputPath, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_DISABLE_DOTENV: "1"
    }
  });
  const result = JSON.parse(output);
  const reportText = fs.readFileSync(path.join(root, outputPath), "utf8");
  const report = JSON.parse(reportText);

  assert.equal(result.output.path, outputPath);
  assert.equal(result.output.policy.status, "allow");
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.successRate, 0);
});

test("CLI eval fixtures appends compact history through policy", () => {
  const root = copyRepoWithoutSecrets();
  const historyPath = "reports/eval-history.jsonl";

  const output = execFileSync(process.execPath, [path.join(root, "bin", "vibeguard.js"), "--root", root, "eval", "fixtures", "--history", historyPath, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_LLM_PROVIDER: "fixture",
      VIBEGUARD_FIXTURE_PATCH_MAP: fixturePatchMap(),
      VIBEGUARD_DISABLE_DOTENV: "1"
    }
  });
  const result = JSON.parse(output);
  const lines = fs.readFileSync(path.join(root, historyPath), "utf8").trim().split("\n");
  const history = JSON.parse(lines[0]);

  assert.equal(result.history.path, historyPath);
  assert.equal(result.history.policy.status, "allow");
  assert.equal(history.summary.successRate, 1);
  assert.equal(history.results.length, 2);
  assert.equal(JSON.stringify(history).includes("tempRoot"), false);
});

test("CLI eval fixtures blocks report output on denied path", () => {
  const root = copyRepoWithoutSecrets();
  let output;
  try {
    output = execFileSync(process.execPath, [path.join(root, "bin", "vibeguard.js"), "--root", root, "eval", "fixtures", "--output", ".env", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        VIBEGUARD_DISABLE_DOTENV: "1"
      }
    });
  } catch (error) {
    output = error.stdout;
  }
  const result = JSON.parse(output);

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "output_report");
  assert.equal(result.output.policy.status, "deny");
  assert.equal(result.summary.total, 0);
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
});

test("CLI eval fixtures blocks history output on denied path before provider calls", () => {
  const root = copyRepoWithoutSecrets();
  let output;
  try {
    output = execFileSync(process.execPath, [path.join(root, "bin", "vibeguard.js"), "--root", root, "eval", "fixtures", "--history", ".env", "--json"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        VIBEGUARD_LLM_PROVIDER: "fixture",
        VIBEGUARD_FIXTURE_PATCH_MAP: fixturePatchMap(),
        VIBEGUARD_DISABLE_DOTENV: "1"
      }
    });
  } catch (error) {
    output = error.stdout;
  }
  const result = JSON.parse(output);

  assert.equal(result.status, "deny");
  assert.equal(result.stage, "history_report");
  assert.equal(result.history.policy.status, "deny");
  assert.equal(result.summary.total, 0);
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
});
