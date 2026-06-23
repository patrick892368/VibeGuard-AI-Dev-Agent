import fs from "node:fs";
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
