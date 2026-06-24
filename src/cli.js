import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config/loadConfig.js";
import { loadRuntimeEnv } from "./config/env.js";
import { PolicyEngine } from "./policy/engine.js";
import { analyzeDebugLog } from "./agents/debug.js";
import { analyzeRepository, writeOnboardingDocs } from "./agents/onboard.js";
import { analyzeTestTargets, writeSuggestedTests } from "./agents/testWriter.js";
import { analyzeReviewDiff } from "./agents/review.js";
import { buildPrSummary } from "./agents/pr.js";
import { runFixWorkflow } from "./agents/fix.js";
import { applyPatchWithPolicy } from "./patch/safeApply.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "./patch/validatePatch.js";
import { generateDebugPatch } from "./llm/provider.js";
import { hookTemplate, installHook, listHooks } from "./integrations/hooks.js";
import { createPullRequestWithGh, detectGitHubRepository } from "./integrations/github.js";
import { runCommandWithPolicy } from "./runner/safeCommand.js";
import { startMcpServer } from "./mcp/server.js";
import { evaluateFixFixtures, summarizeEvalHistory } from "./eval/fixtures.js";

function printHelp() {
  console.log(`VibeGuard AI Dev Agent

Usage:
  vibeguard policy check [--path <file>] [--command <cmd>] [--patch <file>]
  vibeguard debug --log <file>
  vibeguard fix --log <file> [--patch <file>] [--test <cmd>] [--dry-run] [--apply] [--output-patch <file>] [--write-pr-body <file>] [--execute-git-plan]
  vibeguard test
  vibeguard review [--diff <file>]
  vibeguard onboard [--write]
  vibeguard patch check --file <patch>
  vibeguard patch apply --file <patch> [--confirm]
  vibeguard hooks list
  vibeguard hooks print <pre-commit|pre-push|commit-msg>
  vibeguard hooks install <hook> --allow-git-dir
  vibeguard pr summary [--diff <file>]
  vibeguard github detect
  vibeguard github pr --title <title> [--body-file <file>] [--base <branch>] [--draft] [--execute]
  vibeguard run --command <cmd> [--dry-run] [--confirm]
  vibeguard eval fixtures [--fixture <id>] [--apply] [--output <file>] [--history <file>]
  vibeguard eval history [--file <file>]
  vibeguard mcp

Options:
  --json      Print JSON output
  --root DIR  Repository root, defaults to current working directory
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

function policyCommand(parsed, root) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });

  if (parsed.path) return engine.checkPath(parsed.path);
  if (parsed.command) return engine.checkCommand(parsed.command);
  if (parsed.patch) return engine.checkPatch(fs.readFileSync(resolveInputPath(root, parsed.patch), "utf8"));

  const stdin = readStdinIfAvailable();
  if (stdin.trim()) return engine.checkPatch(stdin);
  throw new Error("policy check requires --path, --command, --patch, or patch text on stdin");
}

async function debugCommand(parsed, root) {
  const logText = parsed.log ? fs.readFileSync(resolveInputPath(root, parsed.log), "utf8") : readStdinIfAvailable();
  if (!logText.trim()) throw new Error("debug requires --log <file> or error text on stdin");
  const result = analyzeDebugLog(logText, { root });
  if (parsed["ai-patch"]) {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const ai = await generateDebugPatch({ ...result, log: logText }, loadRuntimeEnv(root));
    result.aiPatch = ai;
    if (ai.patch) {
      result.aiPatch.patch = normalizeUnifiedDiff(ai.patch);
      result.aiPatch.validation = validateUnifiedDiff(ai.patch);
      result.aiPatch.policy = result.aiPatch.validation.valid
        ? engine.checkPatch(ai.patch)
        : { status: "deny", reason: result.aiPatch.validation.reason, files: result.aiPatch.validation.files };
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
    env: loadRuntimeEnv(root)
  });
}

function reviewCommand(parsed, root) {
  let diffText = "";
  if (parsed.diff) {
    diffText = fs.readFileSync(resolveInputPath(root, parsed.diff), "utf8");
  } else {
    try {
      diffText = execFileSync("git", ["diff", "--cached"], { cwd: root, encoding: "utf8" });
      if (!diffText.trim()) diffText = execFileSync("git", ["diff"], { cwd: root, encoding: "utf8" });
    } catch {
      diffText = readStdinIfAvailable();
    }
  }
  if (!diffText.trim()) throw new Error("review requires a git diff, --diff <file>, or diff text on stdin");
  return analyzeReviewDiff(diffText);
}

function diffInput(parsed, root) {
  if (parsed.diff) return fs.readFileSync(resolveInputPath(root, parsed.diff), "utf8");
  const stdin = readStdinIfAvailable();
  if (stdin.trim()) return stdin;
  return execFileSync("git", ["diff"], { cwd: root, encoding: "utf8" });
}

function patchCommand(parsed, root, subcommand) {
  const patchText = parsed.file ? fs.readFileSync(resolveInputPath(root, parsed.file), "utf8") : readStdinIfAvailable();
  if (!patchText.trim()) throw new Error("patch command requires --file <patch> or patch text on stdin");
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });

  if (subcommand === "check") return engine.checkPatch(patchText);
  if (subcommand === "apply") {
    return applyPatchWithPolicy(root, patchText, engine, {
      confirmed: Boolean(parsed.confirm),
      checkOnly: Boolean(parsed["check-only"])
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
    dryRun: Boolean(parsed["dry-run"])
  });
}

function githubCommand(parsed, root, subcommand) {
  if (subcommand === "detect") return detectGitHubRepository(root);
  if (subcommand === "pr") {
    return createPullRequestWithGh(root, {
      title: parsed.title,
      bodyFile: parsed["body-file"],
      body: parsed.body,
      base: parsed.base,
      head: parsed.head,
      draft: Boolean(parsed.draft),
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
      return writeSuggestedTests(root, engine, { limit: parsed.limit || 1, confirmed: Boolean(parsed.confirm) });
    }
    return analyzeTestTargets({ root });
  }
  if (command === "review") return reviewCommand(parsed, root);
  if (command === "onboard") {
    if (parsed.write) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      return writeOnboardingDocs(root, engine, { confirmed: Boolean(parsed.confirm) });
    }
    return analyzeRepository({ root });
  }
  if (command === "patch") return patchCommand(parsed, root, subcommand);
  if (command === "hooks") return hooksCommand(parsed, root, subcommand);
  if (command === "pr" && subcommand === "summary") return buildPrSummary(diffInput(parsed, root));
  if (command === "github") return githubCommand(parsed, root, subcommand);
  if (command === "run") return runCommand(parsed, root);
  if (command === "eval") return evalCommand(parsed, root, subcommand);
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
  reviewCommand
};
