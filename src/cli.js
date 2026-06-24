import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config/loadConfig.js";
import { loadRuntimeEnv } from "./config/env.js";
import { PolicyEngine } from "./policy/engine.js";
import { analyzeDebugLog } from "./agents/debug.js";
import { analyzeRepository, writeOnboardingDocs } from "./agents/onboard.js";
import { analyzeTestTargets, writeSuggestedTests } from "./agents/testWriter.js";
import { analyzeReviewDiff, writeReviewComment } from "./agents/review.js";
import { buildPrSummary, writePrSummaryBody } from "./agents/pr.js";
import { runFixWorkflow } from "./agents/fix.js";
import { runDoctor } from "./agents/doctor.js";
import { applyPatchWithPolicy } from "./patch/safeApply.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "./patch/validatePatch.js";
import { generateDebugPatch } from "./llm/provider.js";
import { appendAuditEvent, buildAuditMarkdown, summarizeAuditEvents } from "./policy/audit.js";
import { hookTemplate, installHook, listHooks } from "./integrations/hooks.js";
import { commentPullRequestWithGh, createPullRequestWithGh, detectGitHubRepository, listWorkflowRunsWithGh } from "./integrations/github.js";
import { runCommandWithPolicy } from "./runner/safeCommand.js";
import { startMcpServer } from "./mcp/server.js";
import { evaluateFixFixtures, summarizeEvalHistory } from "./eval/fixtures.js";
import { readFileWithPolicy, writeFileWithPolicy } from "./policy/safeWrite.js";

function printHelp() {
  console.log(`VibeGuard AI Dev Agent

Usage:
  vibeguard policy check [--path <file>] [--command <cmd>] [--patch <file>]
  vibeguard debug --log <file> [--ai-patch] [--output-patch <file>]
  vibeguard fix --log <file> [--patch <file>] [--test <cmd>] [--auto-test] [--dry-run] [--apply] [--output-patch <file>] [--write-pr-body <file>] [--execute-git-plan]
  vibeguard test [--coverage <coverage.json|lcov.info>] [--coverage-after <coverage.json|lcov.info>]
  vibeguard test --write [--coverage <coverage.json|lcov.info>] [--coverage-after <coverage.json|lcov.info>] [--run] [--repair] [--test-command <cmd>] [--create-branch] [--commit] [--pr-dry-run] [--execute-git-plan]
  vibeguard review [--diff <file>] [--write-comment <file>]
  vibeguard onboard [--write]
  vibeguard patch check --file <patch>
  vibeguard patch apply --file <patch> [--confirm]
  vibeguard hooks list
  vibeguard hooks print <pre-commit|pre-push|commit-msg>
  vibeguard hooks install <hook> --allow-git-dir
  vibeguard pr summary [--diff <file>] [--write-body <file>]
  vibeguard github detect
  vibeguard github pr --title <title> [--body-file <file>] [--base <branch>] [--draft] [--execute] [--confirm]
  vibeguard github comment --pr <number> [--body-file <file>] [--body <text>] [--execute] [--confirm]
  vibeguard github checks [--branch <branch>] [--limit <n>] [--execute]
  vibeguard run --command <cmd> [--dry-run] [--confirm]
  vibeguard eval fixtures [--fixture <id>] [--repeat <n>] [--apply] [--output <file>] [--history <file>]
  vibeguard eval history [--file <file>]
  vibeguard audit summary [--file <audit.jsonl>]
  vibeguard audit report [--file <audit.jsonl>] --output <audit.md>
  vibeguard doctor
  vibeguard mcp

Options:
  --json      Print JSON output
  --root DIR  Repository root, defaults to current working directory
  --audit-log FILE  Append policy-gated JSONL audit events
`);
}

function parseArgs(args) {
  const parsed = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function printResult(result, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (typeof result === "string") {
    console.log(result);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8");
}

function resolveInputPath(root, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}

function readInputFileWithPolicy(root, filePath, parsed) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  return readFileWithPolicy(root, filePath, engine, {
    confirmed: Boolean(parsed.confirm),
    auditLog: parsed["audit-log"]
  }).content;
}

function withAudit(root, engine, auditLog, result, event, confirmed = false) {
  if (!auditLog) return result;
  return {
    ...result,
    auditLog: appendAuditEvent(root, engine, auditLog, {
      ...event,
      policyStatus: result.status,
      reason: result.reason
    }, { confirmed })
  };
}

function policyCommand(parsed, root) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });

  if (parsed.path) {
    const result = engine.checkPath(parsed.path);
    return withAudit(root, engine, parsed["audit-log"], result, {
      operation: "policy_check_path",
      target: parsed.path,
      outcome: result.status === "allow" || (result.status === "require_confirmation" && parsed.confirm) ? "allowed" : "blocked"
    }, Boolean(parsed.confirm));
  }
  if (parsed.command) {
    const result = engine.checkCommand(parsed.command);
    return withAudit(root, engine, parsed["audit-log"], result, {
      operation: "policy_check_command",
      command: parsed.command,
      outcome: result.status === "allow" || (result.status === "require_confirmation" && parsed.confirm) ? "allowed" : "blocked"
    }, Boolean(parsed.confirm));
  }
  if (parsed.patch) {
    const patchFile = readFileWithPolicy(root, parsed.patch, engine, {
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    });
    const result = engine.checkPatch(patchFile.content);
    return withAudit(root, engine, parsed["audit-log"], result, {
      operation: "policy_check_patch",
      files: result.files,
      outcome: result.status === "allow" || (result.status === "require_confirmation" && parsed.confirm) ? "allowed" : "blocked"
    }, Boolean(parsed.confirm));
  }

  const stdin = readStdinIfAvailable();
  if (stdin.trim()) {
    const result = engine.checkPatch(stdin);
    return withAudit(root, engine, parsed["audit-log"], result, {
      operation: "policy_check_patch",
      files: result.files,
      outcome: result.status === "allow" || (result.status === "require_confirmation" && parsed.confirm) ? "allowed" : "blocked"
    }, Boolean(parsed.confirm));
  }
  throw new Error("policy check requires --path, --command, --patch, or patch text on stdin");
}

async function debugCommand(parsed, root) {
  const logText = parsed.log ? fs.readFileSync(resolveInputPath(root, parsed.log), "utf8") : readStdinIfAvailable();
  if (!logText.trim()) throw new Error("debug requires --log <file> or error text on stdin");
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const result = analyzeDebugLog(logText, { root, engine });
  if (parsed["ai-patch"]) {
    const ai = await generateDebugPatch({ ...result, log: logText }, loadRuntimeEnv(root));
    result.aiPatch = ai;
    if (ai.patch) {
      const normalizedPatch = normalizeUnifiedDiff(ai.patch);
      result.aiPatch.patch = normalizedPatch;
      result.aiPatch.validation = validateUnifiedDiff(normalizedPatch);
      result.aiPatch.policy = result.aiPatch.validation.valid
        ? engine.checkPatch(normalizedPatch)
        : { status: "deny", reason: result.aiPatch.validation.reason, files: result.aiPatch.validation.files };
      if (parsed["output-patch"]) {
        if (result.aiPatch.policy.status !== "allow" && !(result.aiPatch.policy.status === "require_confirmation" && parsed.confirm)) {
          result.aiPatch.outputPatch = {
            status: result.aiPatch.policy.status,
            stage: "patch_policy",
            path: parsed["output-patch"],
            policy: result.aiPatch.policy
          };
        } else if (result.aiPatch.validation.valid) {
          result.aiPatch.outputPatch = writeFileWithPolicy(root, parsed["output-patch"], normalizedPatch, engine, {
            confirmed: Boolean(parsed.confirm),
            auditLog: parsed["audit-log"]
          });
        }
      }
    }
  }
  return result;
}

async function fixCommand(parsed, root) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  return runFixWorkflow({
    root,
    engine,
    logFile: parsed.log,
    patchFile: parsed.patch,
    testCommand: parsed.test,
    autoTest: Boolean(parsed["auto-test"]),
    outputPatch: parsed["output-patch"],
    writePrBody: parsed["write-pr-body"],
    createBranch: Boolean(parsed["create-branch"]),
    commit: Boolean(parsed.commit),
    push: Boolean(parsed.push),
    prDryRun: Boolean(parsed["pr-dry-run"]),
    createPr: Boolean(parsed["create-pr"]),
    executeGitPlan: Boolean(parsed["execute-git-plan"]),
    prBodyFile: parsed["pr-body-file"],
    dryRun: Boolean(parsed["dry-run"]),
    apply: Boolean(parsed.apply),
    confirmed: Boolean(parsed.confirm),
    auditLog: parsed["audit-log"],
    env: loadRuntimeEnv(root)
  });
}

function reviewCommand(parsed, root) {
  let diffText = "";
  if (parsed.diff) {
    diffText = readInputFileWithPolicy(root, parsed.diff, parsed);
  } else {
    try {
      diffText = execFileSync("git", ["diff", "--cached"], { cwd: root, encoding: "utf8" });
      if (!diffText.trim()) diffText = execFileSync("git", ["diff"], { cwd: root, encoding: "utf8" });
    } catch {
      diffText = readStdinIfAvailable();
    }
  }
  if (!diffText.trim()) throw new Error("review requires a git diff, --diff <file>, or diff text on stdin");
  if (parsed["write-comment"]) {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return writeReviewComment(root, diffText, parsed["write-comment"], engine, {
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    });
  }
  return analyzeReviewDiff(diffText);
}

function diffInput(parsed, root) {
  if (parsed.diff) return readInputFileWithPolicy(root, parsed.diff, parsed);
  const stdin = readStdinIfAvailable();
  if (stdin.trim()) return stdin;
  return execFileSync("git", ["diff"], { cwd: root, encoding: "utf8" });
}

function patchCommand(parsed, root, subcommand) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const patchText = parsed.file
    ? readFileWithPolicy(root, parsed.file, engine, {
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    }).content
    : readStdinIfAvailable();
  if (!patchText.trim()) throw new Error("patch command requires --file <patch> or patch text on stdin");

  if (subcommand === "check") {
    const result = engine.checkPatch(patchText);
    return withAudit(root, engine, parsed["audit-log"], result, {
      operation: "check_patch",
      files: result.files,
      outcome: result.status === "allow" || (result.status === "require_confirmation" && parsed.confirm) ? "allowed" : "blocked"
    }, Boolean(parsed.confirm));
  }
  if (subcommand === "apply") {
    return applyPatchWithPolicy(root, patchText, engine, {
      confirmed: Boolean(parsed.confirm),
      checkOnly: Boolean(parsed["check-only"]),
      auditLog: parsed["audit-log"]
    });
  }
  throw new Error(`Unknown patch command: ${subcommand || ""}`);
}

function hooksCommand(parsed, root, subcommand) {
  const hookName = parsed._[2];
  if (subcommand === "list") return { hooks: listHooks() };
  if (subcommand === "print") return hookTemplate(hookName);
  if (subcommand === "install") {
    return installHook(root, hookName, { allowGitDir: Boolean(parsed["allow-git-dir"]) });
  }
  throw new Error(`Unknown hooks command: ${subcommand || ""}`);
}

function runCommand(parsed, root) {
  if (!parsed.command) throw new Error("run requires --command <cmd>");
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  return runCommandWithPolicy(root, parsed.command, engine, {
    confirmed: Boolean(parsed.confirm),
    dryRun: Boolean(parsed["dry-run"]),
    auditLog: parsed["audit-log"]
  });
}

function githubMutationPolicy(root, command, stage, confirmed) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const policy = engine.checkCommand(command);
  if (policy.status !== "allow" && !(policy.status === "require_confirmation" && confirmed)) {
    return {
      status: policy.status,
      stage,
      command,
      policy
    };
  }
  return null;
}

async function githubCommand(parsed, root, subcommand) {
  const env = loadRuntimeEnv(root);
  if (subcommand === "detect") return detectGitHubRepository(root);
  if (subcommand === "pr") {
    const options = {
      title: parsed.title,
      bodyFile: parsed["body-file"],
      body: parsed.body,
      base: parsed.base,
      head: parsed.head,
      draft: Boolean(parsed.draft)
    };
    const dryRun = await createPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: true
    });
    if (parsed.execute) {
      const blocked = githubMutationPolicy(root, dryRun.command, "github_pr_policy", Boolean(parsed.confirm));
      if (blocked) return blocked;
    }
    return createPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: !parsed.execute
    });
  }
  if (subcommand === "comment") {
    const options = {
      pr: parsed.pr,
      bodyFile: parsed["body-file"],
      body: parsed.body
    };
    const dryRun = await commentPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: true
    });
    if (parsed.execute) {
      const blocked = githubMutationPolicy(root, dryRun.command, "github_comment_policy", Boolean(parsed.confirm));
      if (blocked) return blocked;
    }
    return commentPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: !parsed.execute
    });
  }
  if (subcommand === "checks") {
    return listWorkflowRunsWithGh(root, {
      branch: parsed.branch,
      workflow: parsed.workflow,
      limit: parsed.limit,
      env,
      dryRun: !parsed.execute
    });
  }
  throw new Error(`Unknown github command: ${subcommand || ""}`);
}

async function evalCommand(parsed, root, subcommand) {
  if (subcommand === "fixtures") {
    return evaluateFixFixtures({
      root,
      fixture: parsed.fixture,
      repeat: parsed.repeat,
      apply: Boolean(parsed.apply),
      output: parsed.output,
      history: parsed.history,
      confirmed: Boolean(parsed.confirm),
      env: loadRuntimeEnv(root)
    });
  }
  if (subcommand === "history") {
    return summarizeEvalHistory({
      root,
      file: parsed.file,
      limit: parsed.limit,
      confirmed: Boolean(parsed.confirm)
    });
  }
  throw new Error(`Unknown eval command: ${subcommand || ""}`);
}

function auditCommand(parsed, root, subcommand) {
  if (subcommand === "summary" || subcommand === "report") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const file = parsed.file || "reports/audit.jsonl";
    const auditFile = readFileWithPolicy(root, file, engine, {
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    });
    const summary = {
      ...summarizeAuditEvents(auditFile.content, { limit: parsed.limit }),
      audit: {
        path: auditFile.path,
        policy: auditFile.policy,
        auditLog: auditFile.auditLog
      }
    };
    if (subcommand === "summary") return summary;
    if (!parsed.output) throw new Error("audit report requires --output <audit.md>");
    return {
      ...summary,
      report: writeFileWithPolicy(root, parsed.output, buildAuditMarkdown(summary), engine, {
        confirmed: Boolean(parsed.confirm),
        auditLog: parsed["audit-log"]
      })
    };
  }
  throw new Error(`Unknown audit command: ${subcommand || ""}`);
}

async function dispatch(parsed) {
  const root = parsed.root ? String(parsed.root) : process.cwd();
  const [command, subcommand] = parsed._;

  if (!command || command === "help" || parsed.help) {
    printHelp();
    return null;
  }

  if (command === "policy" && subcommand === "check") return policyCommand(parsed, root);
  if (command === "debug") return debugCommand(parsed, root);
  if (command === "fix") return fixCommand(parsed, root);
  if (command === "test") {
    if (parsed.write) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      return writeSuggestedTests(root, engine, {
        limit: parsed.limit || 1,
        coverageFile: parsed.coverage,
        coverageAfterFile: parsed["coverage-after"],
        runTests: Boolean(parsed.run),
        repairFailures: Boolean(parsed.repair),
        testCommand: parsed["test-command"],
        createBranch: Boolean(parsed["create-branch"]),
        commit: Boolean(parsed.commit),
        push: Boolean(parsed.push),
        prDryRun: Boolean(parsed["pr-dry-run"]),
        createPr: Boolean(parsed["create-pr"]),
        executeGitPlan: Boolean(parsed["execute-git-plan"]),
        branch: parsed.branch,
        commitMessage: parsed["commit-message"],
        prTitle: parsed["pr-title"],
        prBodyFile: parsed["pr-body-file"],
        dryRun: Boolean(parsed["dry-run"]),
        confirmed: Boolean(parsed.confirm),
        auditLog: parsed["audit-log"]
      });
    }
    return analyzeTestTargets({ root, coverageFile: parsed.coverage, coverageAfterFile: parsed["coverage-after"] });
  }
  if (command === "review") return reviewCommand(parsed, root);
  if (command === "onboard") {
    if (parsed.write) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      return writeOnboardingDocs(root, engine, { confirmed: Boolean(parsed.confirm), auditLog: parsed["audit-log"] });
    }
    return analyzeRepository({ root });
  }
  if (command === "patch") return patchCommand(parsed, root, subcommand);
  if (command === "hooks") return hooksCommand(parsed, root, subcommand);
  if (command === "pr" && subcommand === "summary") {
    const diffText = diffInput(parsed, root);
    if (parsed["write-body"]) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      return writePrSummaryBody(root, diffText, parsed["write-body"], engine, {
        confirmed: Boolean(parsed.confirm),
        auditLog: parsed["audit-log"]
      });
    }
    return buildPrSummary(diffText);
  }
  if (command === "github") return githubCommand(parsed, root, subcommand);
  if (command === "run") return runCommand(parsed, root);
  if (command === "eval") return evalCommand(parsed, root, subcommand);
  if (command === "audit") return auditCommand(parsed, root, subcommand);
  if (command === "doctor") return runDoctor({ root, env: loadRuntimeEnv(root) });
  if (command === "mcp") {
    await startMcpServer({ root });
    return null;
  }

  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
}

export async function runCli(args) {
  const parsed = parseArgs(args);
  const result = await dispatch(parsed);
  if (result !== null) {
    printResult(result, Boolean(parsed.json));
    if (result.status === "deny" || (parsed.strict && result.status === "require_confirmation")) {
      process.exitCode = result.status === "deny" ? 2 : 3;
    }
  }
}

export const cliInternals = {
  parseArgs,
  policyCommand,
  debugCommand,
  fixCommand,
  evalCommand,
  auditCommand,
  reviewCommand
};
