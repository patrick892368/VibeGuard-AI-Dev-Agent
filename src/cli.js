import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/loadConfig.js";
import { loadRuntimeEnv } from "./config/env.js";
import { PolicyEngine } from "./policy/engine.js";
import { analyzeDebugLog } from "./agents/debug.js";
import { analyzeRepository, writeOnboardingDocs } from "./agents/onboard.js";
import { analyzeTestTargets, writeSuggestedTestsAsync } from "./agents/testWriter.js";
import { analyzeReviewDiff, publishReviewComment, writeReviewComment } from "./agents/review.js";
import { buildPrSummary, writePrSummaryBody } from "./agents/pr.js";
import { runFixWorkflow } from "./agents/fix.js";
import { runDoctor } from "./agents/doctor.js";
import { applyPatchWithPolicy } from "./patch/safeApply.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "./patch/validatePatch.js";
import { generateDebugPatch } from "./llm/provider.js";
import { appendAuditEvent, buildAuditMarkdown, summarizeAuditEvents } from "./policy/audit.js";
import { hookTemplate, installHook, listHooks } from "./integrations/hooks.js";
import { GITHUB_CURRENT_BRANCH_COMMAND, GITHUB_DETECT_COMMAND, checkGitHubCommandsPolicy, commentPullRequestWithGh, createPullRequestWithGh, createReviewCommentWithGh, createReviewCommentsWithGh, detectGitHubRepository, getPullRequestDiffWithGh, listWorkflowRunsWithGh } from "./integrations/github.js";
import { commandDisplay, runArgvWithPolicy, runCommandWithPolicy } from "./runner/safeCommand.js";
import { startMcpServer } from "./mcp/server.js";
import { evaluateFixFixtures, summarizeEvalHistory } from "./eval/fixtures.js";
import { readFileWithPolicy, writeFileWithPolicy } from "./policy/safeWrite.js";

function printHelp() {
  console.log(`VibeGuard AI Dev Agent

Usage:
  vibeguard policy check [--path <file>] [--command <cmd>] [--patch <file>]
  vibeguard debug --log <file> [--ai-patch] [--output-patch <file>]
  vibeguard fix --log <file> [--patch <file>] [--test <cmd>] [--auto-test] [--dry-run] [--apply] [--output-patch <file>] [--write-pr-body <file>] [--execute-git-plan] [--github-api]
  vibeguard test [--coverage <coverage.json|lcov.info>] [--coverage-after <coverage.json|lcov.info>]
  vibeguard test --write [--coverage <coverage.json|lcov.info>] [--coverage-after <coverage.json|lcov.info>] [--run] [--repair] [--test-command <cmd>] [--create-branch] [--commit] [--pr-dry-run] [--execute-git-plan] [--github-api]
  vibeguard review [--diff <file>] [--github-pr <number>] [--write-comment <file>] [--publish-comment|--comment-pr <number>] [--execute] [--confirm] [--github-api]
  vibeguard onboard [--write] [--confirm]
  vibeguard patch check --file <patch>
  vibeguard patch apply --file <patch> [--confirm]
  vibeguard hooks list
  vibeguard hooks print <pre-commit|pre-push|commit-msg>
  vibeguard hooks install <hook> --allow-git-dir
  vibeguard pr summary [--diff <file>] [--github-pr <number>] [--write-body <file>] [--github-api]
  vibeguard github detect
  vibeguard github pr --title <title> [--body-file <file>] [--base <branch>] [--draft] [--execute] [--confirm] [--github-api]
  vibeguard github comment --pr <number> [--body-file <file>] [--body <text>] [--execute] [--confirm] [--github-api]
  vibeguard github review-comment --pr <number> --commit <sha> --path <file> --line <line> [--body-file <file>] [--body <text>] [--execute] [--confirm] [--github-api]
  vibeguard github review-comments --pr <number> --commit <sha> [--diff <file>] [--github-pr <number>] [--limit <n>] [--execute] [--confirm] [--github-api]
  vibeguard github checks [--branch <branch>] [--limit <n>] [--execute] [--github-api]
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
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const logText = parsed.log
    ? readFileWithPolicy(root, parsed.log, engine, {
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    }).content
    : readStdinIfAvailable();
  if (!logText.trim()) throw new Error("debug requires --log <file> or error text on stdin");
  const result = analyzeDebugLog(logText, {
    root,
    engine,
    confirmed: Boolean(parsed.confirm),
    auditLog: parsed["audit-log"]
  });
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
    env: loadRuntimeEnv(root),
    githubUseApi: Boolean(parsed["github-api"])
  });
}

function blockedCommandPolicyResult(root, engine, parsed, argv, stage) {
  const command = commandDisplay(argv);
  const policy = engine.checkCommand(command);
  if (policy.status === "allow" || (policy.status === "require_confirmation" && parsed.confirm)) {
    return null;
  }
  const auditLog = appendAuditEvent(root, engine, parsed["audit-log"], {
    operation: "run_command",
    command,
    argv,
    policyStatus: policy.status,
    outcome: "blocked",
    dryRun: false,
    reason: policy.reason
  }, { confirmed: Boolean(parsed.confirm) });
  return {
    status: policy.status,
    stage,
    command,
    argv,
    policy,
    auditLog
  };
}

function runGitDiffCommand(root, parsed, argv, stage) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const blocked = blockedCommandPolicyResult(root, engine, parsed, argv, stage);
  if (blocked) return { blocked };

  return {
    result: runArgvWithPolicy(root, argv, engine, {
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    })
  };
}

function readGitDiffWithPolicy(parsed, root, options = {}) {
  const commands = options.preferCached
    ? [["git", "diff", "--cached"], ["git", "diff"]]
    : [["git", "diff"]];
  for (const argv of commands) {
    const run = runGitDiffCommand(root, parsed, argv, options.stage || "git_diff_policy");
    if (run.blocked) return run.blocked;
    if (run.result.status !== "passed") return readStdinIfAvailable();
    if (run.result.stdout.trim()) return run.result.stdout;
  }
  return readStdinIfAvailable();
}

async function readGitHubPrDiffWithPolicy(parsed, root, options = {}) {
  if (!parsed["github-pr"]) return null;
  const command = `gh pr diff ${parsed["github-pr"]}`;
  const blocked = githubMutationPolicy(root, command, options.stage || "github_pr_diff_policy", Boolean(parsed.confirm));
  if (blocked) return blocked;
  if (parsed["github-api"]) {
    const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], options.stage || "github_pr_diff_policy", Boolean(parsed.confirm));
    if (prerequisiteBlocked) return prerequisiteBlocked;
  }
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  try {
    const result = await getPullRequestDiffWithGh(root, {
      pr: parsed["github-pr"],
      env: loadRuntimeEnv(root),
      dryRun: false,
      useApi: Boolean(parsed["github-api"]),
      engine,
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    });
    if (result.status !== "fetched") {
      return {
        ...result,
        stage: result.stage || options.stage || "github_pr_diff"
      };
    }
    return result.diff;
  } catch (error) {
    return {
      status: "failed",
      stage: options.stage || "github_pr_diff",
      error: error.message
    };
  }
}

async function diffInputAsync(parsed, root, options = {}) {
  if (parsed["github-pr"]) return readGitHubPrDiffWithPolicy(parsed, root, options);
  if (parsed.diff) return readInputFileWithPolicy(root, parsed.diff, parsed);
  const stdin = readStdinIfAvailable();
  if (stdin.trim()) return stdin;
  return readGitDiffWithPolicy(parsed, root, {
    preferCached: Boolean(options.preferCached),
    stage: options.gitStage || "pr_summary_git_diff_policy"
  });
}

async function reviewCommand(parsed, root) {
  const diffText = await diffInputAsync(parsed, root, {
    preferCached: true,
    gitStage: "review_git_diff_policy",
    stage: "review_github_pr_diff_policy"
  });
  if (typeof diffText !== "string") return diffText;
  if (!diffText.trim()) throw new Error("review requires a git diff, --diff <file>, or diff text on stdin");
  const commentPr = parsed["comment-pr"] || (parsed["publish-comment"] && parsed["github-pr"]);
  if (parsed["publish-comment"] && !commentPr) {
    throw new Error("review --publish-comment requires --github-pr or --comment-pr <number>");
  }
  if (commentPr) {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return publishReviewComment(root, diffText, engine, {
      pr: commentPr,
      writeComment: parsed["write-comment"],
      execute: Boolean(parsed.execute),
      useApi: Boolean(parsed["github-api"]),
      env: loadRuntimeEnv(root),
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"],
      stage: "review_comment_policy",
      prerequisiteStage: "review_comment_prerequisite_policy"
    });
  }
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
  return readGitDiffWithPolicy(parsed, root, {
    stage: "pr_summary_git_diff_policy"
  });
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
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return installHook(root, hookName, {
      allowGitDir: Boolean(parsed["allow-git-dir"]),
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"],
      engine
    });
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

function githubBodyFilePolicy(root, bodyFile, stage, confirmed) {
  if (!bodyFile) return null;
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const policy = engine.checkPath(bodyFile, "read_github_body");
  if (policy.status !== "allow" && !(policy.status === "require_confirmation" && confirmed)) {
    return {
      status: policy.status,
      stage,
      path: bodyFile,
      policy
    };
  }
  return null;
}

function githubPrerequisitePolicy(root, commands, stage, confirmed) {
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const policy = checkGitHubCommandsPolicy(commands.map((command, index) => ({ index: index + 1, command })), engine, {
    confirmed,
    stage
  });
  return policy.status === "allow" ? null : policy;
}

async function githubCommand(parsed, root, subcommand) {
  const env = loadRuntimeEnv(root);
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const executionPolicyOptions = {
    engine,
    confirmed: Boolean(parsed.confirm),
    auditLog: parsed["audit-log"]
  };
  if (subcommand === "detect") {
    const blocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_detect_policy", Boolean(parsed.confirm));
    if (blocked) return blocked;
    return detectGitHubRepository(root, executionPolicyOptions);
  }
  if (subcommand === "pr") {
    const options = {
      title: parsed.title,
      bodyFile: parsed["body-file"],
      body: parsed.body,
      base: parsed.base,
      head: parsed.head,
      draft: Boolean(parsed.draft),
      useApi: Boolean(parsed["github-api"])
    };
    const bodyFileBlocked = githubBodyFilePolicy(root, options.bodyFile, "github_pr_body_file_policy", Boolean(parsed.confirm));
    if (bodyFileBlocked) return bodyFileBlocked;
    const dryRun = await createPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: true
    });
    if (parsed.execute) {
      const blocked = githubMutationPolicy(root, dryRun.command, "github_pr_policy", Boolean(parsed.confirm));
      if (blocked) return blocked;
      const prerequisites = [GITHUB_DETECT_COMMAND];
      if (!options.head) prerequisites.push(GITHUB_CURRENT_BRANCH_COMMAND);
      const prerequisiteBlocked = githubPrerequisitePolicy(root, prerequisites, "github_pr_prerequisite_policy", Boolean(parsed.confirm));
      if (prerequisiteBlocked) return prerequisiteBlocked;
    }
    return createPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: !parsed.execute,
      ...(parsed.execute ? executionPolicyOptions : {})
    });
  }
  if (subcommand === "comment") {
    const options = {
      pr: parsed.pr,
      bodyFile: parsed["body-file"],
      body: parsed.body,
      useApi: Boolean(parsed["github-api"])
    };
    const bodyFileBlocked = githubBodyFilePolicy(root, options.bodyFile, "github_comment_body_file_policy", Boolean(parsed.confirm));
    if (bodyFileBlocked) return bodyFileBlocked;
    const dryRun = await commentPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: true
    });
    if (parsed.execute) {
      const blocked = githubMutationPolicy(root, dryRun.command, "github_comment_policy", Boolean(parsed.confirm));
      if (blocked) return blocked;
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_comment_prerequisite_policy", Boolean(parsed.confirm));
      if (prerequisiteBlocked) return prerequisiteBlocked;
    }
    return commentPullRequestWithGh(root, {
      ...options,
      env,
      dryRun: !parsed.execute,
      ...(parsed.execute ? executionPolicyOptions : {})
    });
  }
  if (subcommand === "review-comment") {
    const options = {
      pr: parsed.pr,
      bodyFile: parsed["body-file"],
      body: parsed.body,
      commitId: parsed.commit || parsed["commit-id"],
      path: parsed.path,
      line: parsed.line ? Number(parsed.line) : undefined,
      side: parsed.side,
      startLine: parsed["start-line"] ? Number(parsed["start-line"]) : undefined,
      startSide: parsed["start-side"],
      subjectType: parsed["subject-type"],
      useApi: Boolean(parsed["github-api"])
    };
    const bodyFileBlocked = githubBodyFilePolicy(root, options.bodyFile, "github_review_comment_body_file_policy", Boolean(parsed.confirm));
    if (bodyFileBlocked) return bodyFileBlocked;
    const dryRun = await createReviewCommentWithGh(root, {
      ...options,
      env,
      dryRun: true
    });
    if (parsed.execute) {
      const blocked = githubMutationPolicy(root, dryRun.command, "github_review_comment_policy", Boolean(parsed.confirm));
      if (blocked) return blocked;
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_review_comment_prerequisite_policy", Boolean(parsed.confirm));
      if (prerequisiteBlocked) return prerequisiteBlocked;
    }
    return createReviewCommentWithGh(root, {
      ...options,
      env,
      dryRun: !parsed.execute,
      ...(parsed.execute ? executionPolicyOptions : {})
    });
  }
  if (subcommand === "review-comments") {
    const commitId = parsed.commit || parsed["commit-id"];
    const diffText = await diffInputAsync(parsed, root, {
      gitStage: "github_review_comments_git_diff_policy",
      stage: "github_review_comments_pr_diff_policy"
    });
    if (typeof diffText !== "string") return diffText;
    const review = analyzeReviewDiff(diffText);
    const dryRun = await createReviewCommentsWithGh(root, {
      pr: parsed.pr,
      commitId,
      comments: review.reviewComments,
      limit: parsed.limit,
      env,
      useApi: Boolean(parsed["github-api"]),
      dryRun: true
    });
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const commandPolicy = checkGitHubCommandsPolicy(dryRun.comments, engine, {
      confirmed: Boolean(parsed.confirm),
      stage: "github_review_comments_policy"
    });
    if (parsed.execute && commandPolicy.status !== "allow") {
      return {
        ...commandPolicy,
        review,
        publish: dryRun
      };
    }
    if (parsed.execute) {
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_review_comments_prerequisite_policy", Boolean(parsed.confirm));
      if (prerequisiteBlocked) {
        return {
          ...prerequisiteBlocked,
          review,
          publish: dryRun
        };
      }
    }
    const publish = parsed.execute
      ? await createReviewCommentsWithGh(root, {
        pr: parsed.pr,
        commitId,
        comments: review.reviewComments,
        limit: parsed.limit,
        env,
        useApi: Boolean(parsed["github-api"]),
        dryRun: false,
        ...executionPolicyOptions
      })
      : dryRun;
    return {
      status: publish.status,
      review,
      commandPolicy,
      publish
    };
  }
  if (subcommand === "checks") {
    const options = {
      branch: parsed.branch,
      workflow: parsed.workflow,
      limit: parsed.limit,
      env,
      useApi: Boolean(parsed["github-api"]),
      dryRun: true
    };
    const dryRun = await listWorkflowRunsWithGh(root, options);
    if (parsed.execute) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      const commandPolicy = checkGitHubCommandsPolicy([{ index: 1, command: dryRun.command }], engine, {
        confirmed: Boolean(parsed.confirm),
        stage: "github_checks_policy"
      });
      if (commandPolicy.status !== "allow") {
        return {
          ...commandPolicy,
          dryRun
        };
      }
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_checks_prerequisite_policy", Boolean(parsed.confirm));
      if (prerequisiteBlocked) {
        return {
          ...prerequisiteBlocked,
          dryRun
        };
      }
      const result = await listWorkflowRunsWithGh(root, {
        ...options,
        dryRun: false,
        ...executionPolicyOptions
      });
      return {
        ...result,
        commandPolicy
      };
    }
    return dryRun;
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
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    if (parsed.write) {
      return await writeSuggestedTestsAsync(root, engine, {
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
        auditLog: parsed["audit-log"],
        env: loadRuntimeEnv(root),
        githubUseApi: Boolean(parsed["github-api"])
      });
    }
    return analyzeTestTargets({
      root,
      engine,
      coverageFile: parsed.coverage,
      coverageAfterFile: parsed["coverage-after"],
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    });
  }
  if (command === "review") return await reviewCommand(parsed, root);
  if (command === "onboard") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    if (parsed.write) {
      return writeOnboardingDocs(root, engine, { confirmed: Boolean(parsed.confirm), auditLog: parsed["audit-log"] });
    }
    return analyzeRepository({
      root,
      engine,
      confirmed: Boolean(parsed.confirm),
      auditLog: parsed["audit-log"]
    });
  }
  if (command === "patch") return patchCommand(parsed, root, subcommand);
  if (command === "hooks") return hooksCommand(parsed, root, subcommand);
  if (command === "pr" && subcommand === "summary") {
    const diffText = await diffInputAsync(parsed, root, {
      stage: "pr_summary_github_pr_diff_policy"
    });
    if (typeof diffText !== "string") return diffText;
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
