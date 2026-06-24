import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loadConfig.js";
import { loadRuntimeEnv } from "../config/env.js";
import { PolicyEngine } from "../policy/engine.js";
import { runFixWorkflow } from "../agents/fix.js";
import { writeFileWithPolicy } from "../policy/safeWrite.js";

export const defaultEvalFixtures = [
  {
    id: "python-bug",
    language: "python",
    root: "fixtures/python-bug",
    log: "error.log",
    testCommand: "python -m unittest discover -s tests"
  },
  {
    id: "node-bug",
    language: "node",
    root: "fixtures/node-bug",
    log: "error.log",
    testCommand: "npm test"
  }
];

function copyFixtureToTemp(repoRoot, fixture) {
  const source = path.join(repoRoot, fixture.root);
  if (!fs.existsSync(source)) {
    throw new Error(`Fixture does not exist: ${fixture.root}`);
  }

  const target = fs.mkdtempSync(path.join(os.tmpdir(), `vibeguard-eval-${fixture.id}-`));
  fs.cpSync(source, target, { recursive: true });
  execFileSync("git", ["init"], { cwd: target, encoding: "utf8" });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: target, encoding: "utf8" });
  execFileSync("git", ["add", "."], { cwd: target, encoding: "utf8" });
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"], {
    cwd: target,
    encoding: "utf8"
  });
  return target;
}

function classifyResult(result, apply) {
  if (apply) {
    if (result.status === "passed") return "passed";
    if (result.tests?.status === "failed") return "test_failed";
  } else if (result.status === "dry_run" && result.validation?.valid && result.policy?.status === "allow" && result.applyCheck?.status === "checked") {
    return "passed";
  }

  if (result.status === "blocked") return "blocked";
  if (result.stage === "patch_validation") return "patch_validation_failed";
  if (result.stage === "policy" || result.policy?.status === "deny") return "policy_denied";
  if (result.stage === "patch_check") return "patch_check_failed";
  if (result.status === "deny") return "denied";
  if (result.status === "failed") return "failed";
  return "unknown";
}

function summarizeFixture(fixture, tempRoot, result, apply) {
  const outcome = classifyResult(result, apply);
  return {
    id: fixture.id,
    language: fixture.language,
    outcome,
    status: result.status,
    stage: result.stage || null,
    tempRoot,
    error: result.error || null,
    patchSourceStatus: result.patchSource?.status || null,
    patchSourceReason: result.patchSource?.reason || null,
    validation: result.validation || null,
    policyStatus: result.policy?.status || null,
    policyReason: result.policy?.reason || null,
    applyCheckStatus: result.applyCheck?.status || null,
    testStatus: result.tests?.status || null,
    likelyFiles: result.debug?.likelyFiles || [],
    pr: result.pr ? {
      title: result.pr.title,
      branch: result.pr.branch,
      commitMessage: result.pr.commitMessage
    } : null
  };
}

function aggregateResults(results) {
  const total = results.length;
  const counts = {
    passed: 0,
    blocked: 0,
    denied: 0,
    policy_denied: 0,
    patch_validation_failed: 0,
    patch_check_failed: 0,
    test_failed: 0,
    failed: 0,
    unknown: 0
  };

  for (const result of results) {
    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
  }

  return {
    total,
    successRate: total === 0 ? 0 : counts.passed / total,
    counts
  };
}

export async function evaluateFixFixtures(options = {}) {
  const repoRoot = options.root || process.cwd();
  const runtimeEnv = options.env || loadRuntimeEnv(repoRoot);
  let outputPolicy = null;

  if (options.output) {
    const { config } = loadConfig(repoRoot);
    const engine = new PolicyEngine(config, { root: repoRoot });
    outputPolicy = engine.checkPath(options.output, "write_eval_report");
    if (outputPolicy.status !== "allow" && !(outputPolicy.status === "require_confirmation" && options.confirmed)) {
      return {
        status: outputPolicy.status,
        stage: "output_report",
        mode: options.apply ? "apply" : "dry_run",
        provider: runtimeEnv.VIBEGUARD_LLM_PROVIDER || ((runtimeEnv.XAI_API_KEY || runtimeEnv.GROK_API_KEY) ? "grok" : "unset"),
        summary: aggregateResults([]),
        results: [],
        output: {
          path: options.output,
          policy: outputPolicy
        }
      };
    }
  }

  const selected = options.fixture
    ? defaultEvalFixtures.filter((fixture) => fixture.id === options.fixture)
    : defaultEvalFixtures;

  if (selected.length === 0) {
    throw new Error(`Unknown fixture: ${options.fixture}`);
  }

  const results = [];
  for (const fixture of selected) {
    const tempRoot = copyFixtureToTemp(repoRoot, fixture);
    const { config } = loadConfig(tempRoot);
    const engine = new PolicyEngine(config, { root: tempRoot });
    const result = await runFixWorkflow({
      root: tempRoot,
      engine,
      logFile: fixture.log,
      testCommand: fixture.testCommand,
      dryRun: !options.apply,
      apply: Boolean(options.apply),
      env: runtimeEnv
    });

    results.push(summarizeFixture(fixture, tempRoot, result, Boolean(options.apply)));
  }

  const report = {
    status: "completed",
    mode: options.apply ? "apply" : "dry_run",
    provider: runtimeEnv.VIBEGUARD_LLM_PROVIDER || ((runtimeEnv.XAI_API_KEY || runtimeEnv.GROK_API_KEY) ? "grok" : "unset"),
    summary: aggregateResults(results),
    results
  };

  if (!options.output) {
    return report;
  }

  const { config } = loadConfig(repoRoot);
  const engine = new PolicyEngine(config, { root: repoRoot });
  const output = writeFileWithPolicy(repoRoot, options.output, `${JSON.stringify(report, null, 2)}\n`, engine, {
    confirmed: Boolean(options.confirmed)
  });

  return {
    ...report,
    output
  };
}
