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
    ReferenceError: fs.readFileSync(path.resolve("fixtures/node-bug/fixes/reference-error.patch"), "utf8"),
    "django.template.exceptions.TemplateDoesNotExist": fs.readFileSync(path.resolve("fixtures/django-bug/fixes/template-error.patch"), "utf8"),
    "org.springframework.beans.factory.NoSuchBeanDefinitionException": fs.readFileSync(path.resolve("fixtures/spring-boot-bug/fixes/service-annotation.patch"), "utf8")
  });
}

function staleDjangoProviderPatch() {
  return [
    "```diff",
    "diff a/accounts/views.py b/accounts/views.py",
    "index 1234567..89abcde 100644",
    "--- a/accounts/views.py",
    "+++ b/accounts/views.py",
    "@@ -2,7 +2,7 @@ from django.shortcuts import render",
    " ",
    " PROFILE_TEMPLATE = \"accounts/detail.html\"",
    " ",
    "-",
    " def profile_template():",
    "     return PROFILE_TEMPLATE",
    "```"
  ].join("\n");
}

function copyRepoWithoutSecrets() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibeguard-eval-output-"));
  fs.cpSync(path.resolve("."), root, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) &&
      !source.endsWith(`${path.sep}.git`) &&
      !source.includes(`${path.sep}reports${path.sep}`) &&
      !source.endsWith(`${path.sep}reports`) &&
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
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.counts.blocked, 4);
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
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.counts.passed, 4);
  assert.equal(result.summary.successRate, 1);
  assert.deepEqual(result.results.map((item) => item.outcome), ["passed", "passed", "passed", "passed"]);
  assert.ok(result.results.every((item) => item.policyStatus === "allow"));
});

test("evaluateFixFixtures applies all fixture provider patches and runs tests", async () => {
  const result = await evaluateFixFixtures({
    root: process.cwd(),
    apply: true,
    env: {
      VIBEGUARD_LLM_PROVIDER: "fixture",
      VIBEGUARD_FIXTURE_PATCH_MAP: fixturePatchMap()
    }
  });

  assert.equal(result.provider, "fixture");
  assert.equal(result.mode, "apply");
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.counts.passed, 4);
  assert.equal(result.summary.successRate, 1);
  assert.ok(result.results.every((item) => item.testStatus === "passed"));
});

test("evaluateFixFixtures recovers a stale generated Django template patch", async () => {
  const result = await evaluateFixFixtures({
    root: process.cwd(),
    fixture: "django-bug",
    env: {
      VIBEGUARD_LLM_PROVIDER: "fixture",
      VIBEGUARD_FIXTURE_PATCH_MAP: JSON.stringify({
        "django.template.exceptions.TemplateDoesNotExist": staleDjangoProviderPatch()
      })
    }
  });

  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.counts.passed, 1);
  assert.equal(result.results[0].outcome, "passed");
  assert.equal(result.results[0].patchSourceStatus, "recovered");
  assert.equal(result.results[0].patchRecoveryStatus, "recovered");
  assert.equal(result.results[0].patchRecoveryStrategy, "django_template_literal_replacement");
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
  assert.equal(report.summary.total, 4);
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
  assert.equal(history.results.length, 4);
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

test("CLI eval history summarizes JSONL success trends", () => {
  const root = copyRepoWithoutSecrets();
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  fs.writeFileSync(path.join(root, "reports", "eval-history.jsonl"), [
    JSON.stringify({
      timestamp: "2026-06-24T00:00:00.000Z",
      mode: "dry_run",
      provider: "grok",
      model: "grok-test",
      summary: {
        total: 2,
        successRate: 0.5,
        counts: { passed: 1, blocked: 1 }
      },
      results: [
        { id: "python-bug", outcome: "passed" },
        { id: "node-bug", outcome: "blocked" }
      ]
    }),
    JSON.stringify({
      timestamp: "2026-06-24T00:01:00.000Z",
      mode: "dry_run",
      provider: "grok",
      model: "grok-test",
      summary: {
        total: 2,
        successRate: 1,
        counts: { passed: 2 }
      },
      results: [
        { id: "python-bug", outcome: "passed" },
        { id: "node-bug", outcome: "passed" }
      ]
    })
  ].join("\n") + "\n", "utf8");

  const output = execFileSync(process.execPath, [path.join(root, "bin", "vibeguard.js"), "--root", root, "eval", "history", "--file", "reports/eval-history.jsonl", "--json"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      VIBEGUARD_DISABLE_DOTENV: "1"
    }
  });
  const result = JSON.parse(output);

  assert.equal(result.status, "completed");
  assert.equal(result.summary.entries, 2);
  assert.equal(result.summary.latestSuccessRate, 1);
  assert.equal(result.summary.averageSuccessRate, 0.75);
  assert.deepEqual(result.summary.outcomeCounts, { passed: 3, blocked: 1 });
  assert.deepEqual(result.summary.fixtureOutcomeCounts, {
    "python-bug": { passed: 2 },
    "node-bug": { blocked: 1, passed: 1 }
  });
});

test("CLI eval history blocks denied read paths", () => {
  const root = copyRepoWithoutSecrets();
  let output;
  try {
    output = execFileSync(process.execPath, [path.join(root, "bin", "vibeguard.js"), "--root", root, "eval", "history", "--file", ".env", "--json"], {
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
  assert.equal(result.stage, "history_read");
  assert.equal(result.history.policy.status, "deny");
  assert.equal(result.summary.entries, 0);
});
