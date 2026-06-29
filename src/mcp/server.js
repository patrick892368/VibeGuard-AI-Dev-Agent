import readline from "node:readline";
import { loadConfig } from "../config/loadConfig.js";
import { loadRuntimeEnv } from "../config/env.js";
import { PolicyEngine } from "../policy/engine.js";
import { readFileWithPolicy, writeFileWithPolicy } from "../policy/safeWrite.js";
import { buildAuditMarkdown, summarizeAuditEvents } from "../policy/audit.js";
import { analyzeDebugLog } from "../agents/debug.js";
import { runDoctor } from "../agents/doctor.js";
import { runFixWorkflow } from "../agents/fix.js";
import { analyzeRepository } from "../agents/onboard.js";
import { analyzeTestTargets, writeSuggestedTestsAsync } from "../agents/testWriter.js";
import { analyzeReviewDiff, publishReviewComment, writeReviewComment } from "../agents/review.js";
import { buildPrPlanWorkflow, buildPrSummary, writePrSummaryBody } from "../agents/pr.js";
import { GITHUB_CURRENT_BRANCH_COMMAND, GITHUB_DETECT_COMMAND, checkGitHubCommandsPolicy, commentPullRequestWithGh, createPullRequestWithGh, createReviewCommentWithGh, createReviewCommentsWithGh, detectGitHubRepository, getPullRequestDiffWithGh, getPullRequestHeadWithGh, listWorkflowRunsWithGh } from "../integrations/github.js";
import { inspectGithubAuth } from "../integrations/githubAuth.js";
import { evaluateFixFixtures, summarizeEvalHistory } from "../eval/fixtures.js";
import { applyPatchWithPolicy } from "../patch/safeApply.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "../patch/validatePatch.js";
import { generateDebugPatch } from "../llm/provider.js";

const stringSchema = { type: "string" };
const booleanSchema = { type: "boolean" };
const numberSchema = { type: "number" };

const documentationResources = [
  {
    uri: "vibeguard://docs/readme",
    name: "VibeGuard README",
    description: "Project overview, CLI usage, and current capability status.",
    mimeType: "text/markdown",
    path: "README.md"
  },
  {
    uri: "vibeguard://docs/codex",
    name: "Codex Integration",
    description: "Codex-oriented workflow guidance for VibeGuard CLI and MCP usage.",
    mimeType: "text/markdown",
    path: "docs/CODEX.md"
  },
  {
    uri: "vibeguard://docs/integrations",
    name: "Integration Guide",
    description: "CLI, MCP, provider, GitHub, and deferred IDE integration notes.",
    mimeType: "text/markdown",
    path: "docs/INTEGRATIONS.md"
  },
  {
    uri: "vibeguard://docs/policy",
    name: "Policy Guide",
    description: "Policy-as-Code configuration and safety model.",
    mimeType: "text/markdown",
    path: "docs/POLICY.md"
  }
];

const policyResources = [
  {
    uri: "vibeguard://policy/config",
    name: "VibeGuard Policy Config",
    description: "The repository .vibeguard.yaml policy file.",
    mimeType: "text/yaml",
    path: ".vibeguard.yaml"
  }
];

const resources = [
  ...documentationResources.map(({ path: _path, ...resource }) => resource),
  ...policyResources.map(({ path: _path, ...resource }) => resource)
];

const resourceTemplates = [
  {
    uriTemplate: "vibeguard://docs/{name}",
    name: "VibeGuard documentation",
    description: "Read one documented workflow by name: readme, codex, integrations, or policy.",
    mimeType: "text/markdown"
  }
];

const prompts = [
  {
    name: "debug_fix",
    description: "Guide a policy-gated Debug Agent workflow from error log to patch, tests, and PR summary.",
    arguments: [
      { name: "logFile", description: "Optional path to the error log file.", required: false },
      { name: "testCommand", description: "Optional validation command to run after applying a patch.", required: false }
    ]
  },
  {
    name: "repo_onboarding",
    description: "Guide a Repo Onboarding Agent workflow that explains structure, entry points, tests, and first tasks.",
    arguments: [
      { name: "focus", description: "Optional area of the repository to focus on.", required: false }
    ]
  },
  {
    name: "write_tests",
    description: "Guide a Test Writer Agent workflow from coverage gaps to generated tests and coverage delta.",
    arguments: [
      { name: "coverageFile", description: "Optional coverage report path.", required: false },
      { name: "testCommand", description: "Optional command for generated test validation.", required: false }
    ]
  },
  {
    name: "review_pr",
    description: "Guide a PR Review Agent workflow for summary, bug/security/performance/test findings, and review comments.",
    arguments: [
      { name: "githubPr", description: "Optional GitHub PR number or URL.", required: false },
      { name: "diffFile", description: "Optional path to a unified diff file.", required: false }
    ]
  },
  {
    name: "github_pr_loop",
    description: "Guide a protected GitHub PR loop with branch, commit, push, PR body, CI, and comments.",
    arguments: [
      { name: "bodyFile", description: "Optional PR body file path.", required: false },
      { name: "branch", description: "Optional branch name.", required: false }
    ]
  }
];

function objectSchema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function secondsToMs(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 1000)) : undefined;
}

const tools = [
  {
    name: "check_policy",
    description: "Check a file path, command, or patch against .vibeguard.yaml policy.",
    inputSchema: objectSchema({
      path: stringSchema,
      command: stringSchema,
      patch: stringSchema
    })
  },
  {
    name: "debug_error",
    description: "Parse an error log and optionally generate a policy-checked AI patch artifact.",
    inputSchema: objectSchema({
      log: stringSchema,
      logFile: stringSchema,
      aiPatch: booleanSchema,
      outputPatch: stringSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "fix_error",
    description: "Run the safe fix workflow: debug log, patch validation, policy check, optional apply, tests, and PR summary.",
    inputSchema: objectSchema({
      log: stringSchema,
      logFile: stringSchema,
      patch: stringSchema,
      patchFile: stringSchema,
      testCommand: stringSchema,
      autoTest: booleanSchema,
      outputPatch: stringSchema,
      writePrBody: stringSchema,
      createBranch: booleanSchema,
      commit: booleanSchema,
      push: booleanSchema,
      prDryRun: booleanSchema,
      createPr: booleanSchema,
      executeGitPlan: booleanSchema,
      checkCi: booleanSchema,
      workflow: stringSchema,
      ciLimit: numberSchema,
      waitCi: booleanSchema,
      ciWaitTimeout: numberSchema,
      ciWaitInterval: numberSchema,
      githubUseApi: booleanSchema,
      prBodyFile: stringSchema,
      dryRun: booleanSchema,
      apply: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "onboard_repo",
    description: "Scan the repository and return onboarding documentation.",
    inputSchema: objectSchema({
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "write_tests",
    description: "Find source files that are good candidates for new tests, and optionally write/run generated tests through policy.",
    inputSchema: objectSchema({
      write: booleanSchema,
      limit: numberSchema,
      coverageFile: stringSchema,
      coverageText: stringSchema,
      coverageAfterFile: stringSchema,
      coverageAfterText: stringSchema,
      coverageCommand: stringSchema,
      run: booleanSchema,
      repair: booleanSchema,
      testCommand: stringSchema,
      createBranch: booleanSchema,
      commit: booleanSchema,
      push: booleanSchema,
      prDryRun: booleanSchema,
      createPr: booleanSchema,
      executeGitPlan: booleanSchema,
      checkCi: booleanSchema,
      workflow: stringSchema,
      ciLimit: numberSchema,
      waitCi: booleanSchema,
      ciWaitTimeout: numberSchema,
      ciWaitInterval: numberSchema,
      githubUseApi: booleanSchema,
      branch: stringSchema,
      commitMessage: stringSchema,
      prTitle: stringSchema,
      prBodyFile: stringSchema,
      dryRun: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "review_pr",
    description: "Analyze a unified diff for review findings.",
    inputSchema: objectSchema({
      diff: stringSchema,
      diffFile: stringSchema,
      githubPr: stringSchema,
      useApi: booleanSchema,
      writeComment: stringSchema,
      publishComment: booleanSchema,
      commentPr: stringSchema,
      execute: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "apply_patch_safely",
    description: "Validate and optionally apply a unified diff through Policy-as-Code. Checks only by default.",
    inputSchema: objectSchema({
      patch: stringSchema,
      apply: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    }, ["patch"])
  },
  {
    name: "summarize_pr",
    description: "Build a GitHub-ready PR summary from a unified diff.",
    inputSchema: objectSchema({
      diff: stringSchema,
      diffFile: stringSchema,
      githubPr: stringSchema,
      useApi: booleanSchema,
      writeBody: stringSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "plan_pr",
    description: "Build a policy-gated branch, commit, and PR creation plan from a unified diff.",
    inputSchema: objectSchema({
      diff: stringSchema,
      diffFile: stringSchema,
      githubPr: stringSchema,
      useApi: booleanSchema,
      writeBody: stringSchema,
      bodyFile: stringSchema,
      title: stringSchema,
      branch: stringSchema,
      commitMessage: stringSchema,
      createBranch: booleanSchema,
      commit: booleanSchema,
      push: booleanSchema,
      prDryRun: booleanSchema,
      executeGitPlan: booleanSchema,
      checkCi: booleanSchema,
      workflow: stringSchema,
      ciLimit: numberSchema,
      waitCi: booleanSchema,
      ciWaitTimeout: numberSchema,
      ciWaitInterval: numberSchema,
      githubUseApi: booleanSchema,
      dryRun: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "detect_github",
    description: "Detect the GitHub origin repository for the current repo.",
    inputSchema: objectSchema({
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "github_auth",
    description: "Check GitHub remote and write-auth readiness for PR/comment/review-comment execution without exposing tokens.",
    inputSchema: objectSchema({
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "github_pr",
    description: "Create a GitHub PR through gh pr create or the REST API fallback. Dry-run by default.",
    inputSchema: objectSchema({
      title: stringSchema,
      bodyFile: stringSchema,
      body: stringSchema,
      base: stringSchema,
      head: stringSchema,
      draft: booleanSchema,
      useApi: booleanSchema,
      execute: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "github_checks",
    description: "Read recent GitHub Actions workflow run status through gh run list or the REST API fallback.",
    inputSchema: objectSchema({
      branch: stringSchema,
      workflow: stringSchema,
      limit: numberSchema,
      wait: booleanSchema,
      waitTimeout: numberSchema,
      waitInterval: numberSchema,
      useApi: booleanSchema,
      execute: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "github_comment",
    description: "Create a GitHub PR comment through gh pr comment or the REST API fallback. Dry-run by default.",
    inputSchema: objectSchema({
      pr: stringSchema,
      bodyFile: stringSchema,
      body: stringSchema,
      useApi: booleanSchema,
      execute: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "github_review_comment",
    description: "Create a GitHub PR review comment on a specific file line through gh api or the REST API fallback. Dry-run by default.",
    inputSchema: objectSchema({
      pr: stringSchema,
      bodyFile: stringSchema,
      body: stringSchema,
      commitId: stringSchema,
      path: stringSchema,
      line: numberSchema,
      side: stringSchema,
      startLine: numberSchema,
      startSide: stringSchema,
      subjectType: stringSchema,
      useApi: booleanSchema,
      execute: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "github_review_comments",
    description: "Analyze a diff and publish generated file-line GitHub PR review comments through gh api or the REST API fallback. Dry-run by default.",
    inputSchema: objectSchema({
      pr: stringSchema,
      commitId: stringSchema,
      diff: stringSchema,
      diffFile: stringSchema,
      githubPr: stringSchema,
      limit: numberSchema,
      useApi: booleanSchema,
      execute: booleanSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "eval_fixtures",
    description: "Evaluate the configured LLM provider against Python, Node, Django-style, and Spring Boot-style fix fixtures.",
    inputSchema: objectSchema({
      fixture: stringSchema,
      repeat: numberSchema,
      apply: booleanSchema,
      output: stringSchema,
      history: stringSchema,
      confirmed: booleanSchema
    })
  },
  {
    name: "eval_history",
    description: "Summarize compact JSONL fixture evaluation history.",
    inputSchema: objectSchema({
      file: stringSchema,
      limit: numberSchema,
      confirmed: booleanSchema
    })
  },
  {
    name: "doctor",
    description: "Check local VibeGuard runtime, policy, provider, git, gh, and proxy readiness without exposing secrets.",
    inputSchema: objectSchema()
  },
  {
    name: "audit_summary",
    description: "Summarize a policy-gated JSONL audit log.",
    inputSchema: objectSchema({
      file: stringSchema,
      limit: numberSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "audit_report",
    description: "Write a Markdown audit report from a policy-gated JSONL audit log.",
    inputSchema: objectSchema({
      file: stringSchema,
      output: stringSchema,
      limit: numberSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    }, ["output"])
  }
];

function validateSchemaValue(name, value, schema) {
  if (schema.type === "string" && typeof value !== "string") return `${name} must be a string`;
  if (schema.type === "boolean" && typeof value !== "boolean") return `${name} must be a boolean`;
  if (schema.type === "number" && typeof value !== "number") return `${name} must be a number`;
  if (schema.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) return `${name} must be an object`;
  return null;
}

function validateToolArguments(name, args = {}) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const schema = tool.inputSchema || objectSchema();
  const rootError = validateSchemaValue("arguments", args, schema);
  if (rootError) throw new Error(rootError);

  const properties = schema.properties || {};
  const errors = [];
  for (const requiredKey of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(args, requiredKey)) {
      errors.push(`Missing required argument: ${requiredKey}`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(`Unknown argument: ${key}`);
      }
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
    const error = validateSchemaValue(key, value, properties[key]);
    if (error) errors.push(error);
  }
  if (errors.length > 0) throw new Error(`Invalid arguments for ${name}: ${errors.join("; ")}`);
  return args;
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, error) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error.message || String(error)
    }
  };
}

function toolContent(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: result
  };
}

function toolErrorContent(error) {
  const message = error.message || String(error);
  return {
    content: [
      {
        type: "text",
        text: message
      }
    ],
    isError: true,
    structuredContent: {
      status: "error",
      error: message
    }
  };
}

function initializeResult(params = {}) {
  return {
    protocolVersion: params.protocolVersion || "2024-11-05",
    capabilities: {
      tools: {},
      resources: { listChanged: false },
      prompts: { listChanged: false },
      logging: {}
    },
    serverInfo: {
      name: "vibeguard-ai-dev-agent",
      version: "0.1.0"
    }
  };
}

function findResource(uri) {
  const candidates = [...documentationResources, ...policyResources];
  return candidates.find((resource) => resource.uri === uri) || null;
}

function readMcpResource(root, uri, options = {}) {
  if (!uri) throw new Error("resources/read requires uri");
  const resource = findResource(uri);
  if (!resource) throw new Error(`Unknown resource: ${uri}`);
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  const read = readFileWithPolicy(root, resource.path, engine, {
    confirmed: Boolean(options.confirmed),
    auditLog: options.auditLog
  });
  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: read.content
      }
    ]
  };
}

function promptText(name, args = {}) {
  const logFile = args.logFile ? ` Use log file: ${args.logFile}.` : "";
  const testCommand = args.testCommand ? ` Validate with: ${args.testCommand}.` : "";
  const coverageFile = args.coverageFile ? ` Use coverage report: ${args.coverageFile}.` : "";
  const focus = args.focus ? ` Focus area: ${args.focus}.` : "";
  const githubPr = args.githubPr ? ` Target PR: ${args.githubPr}.` : "";
  const diffFile = args.diffFile ? ` Use diff file: ${args.diffFile}.` : "";
  const bodyFile = args.bodyFile ? ` Use PR body file: ${args.bodyFile}.` : "";
  const branch = args.branch ? ` Target branch: ${args.branch}.` : "";

  if (name === "debug_fix") {
    return `Run a VibeGuard Debug Agent workflow in the current repository.${logFile}${testCommand}
Use debug_error first to explain the failure and identify likely files. If a patch is needed, generate or inspect a unified diff, check it with apply_patch_safely, apply only after policy passes, run the smallest relevant tests, then produce a PR summary or plan_pr result. Prefer structuredContent and stop on deny or unconfirmed policy results.`;
  }
  if (name === "repo_onboarding") {
    return `Run a VibeGuard Repo Onboarding workflow in the current repository.${focus}
Use onboard_repo to identify language, framework, dependencies, entry points, tests, core modules, and low-risk first tasks. Summarize startup steps and developer docs without reading denied paths. Prefer structuredContent.`;
  }
  if (name === "write_tests") {
    return `Run a VibeGuard Test Writer workflow in the current repository.${coverageFile}${testCommand}
Use write_tests to identify uncovered or low-risk targets, generate tests only through policy-gated writes, run the selected validation command, repair failing generated tests when appropriate, and report coverage delta plus PR metadata. Prefer structuredContent and stop on deny or unconfirmed policy results.`;
  }
  if (name === "review_pr") {
    return `Run a VibeGuard PR Review workflow in the current repository.${githubPr}${diffFile}
Use review_pr or summarize_pr to inspect the diff through policy-gated inputs. Report bugs, security risks, performance issues, missing tests, and concrete file-level suggestions. If publishing, run github_auth first and use dry-run comments unless write auth and policy confirmation are present.`;
  }
  if (name === "github_pr_loop") {
    return `Run a protected VibeGuard GitHub PR workflow in the current repository.${bodyFile}${branch}
Start with github_auth. Use plan_pr or the agent-specific PR options to generate branch, commit message, PR body, push/PR plan, CI checks, and optional comments. Execute only after command, path, and GitHub auth policy gates pass; otherwise return the structured nextActions.`;
  }
  throw new Error(`Unknown prompt: ${name}`);
}

function getPrompt(name, args = {}) {
  const prompt = prompts.find((item) => item.name === name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  return {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: promptText(name, args)
        }
      }
    ]
  };
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

async function readGitHubPrDiff(root, args = {}, stage = "github_pr_diff_policy") {
  if (!args.githubPr) return null;
  const command = `gh pr diff ${args.githubPr}`;
  const commandBlocked = githubPrerequisitePolicy(root, [command], stage, Boolean(args.confirmed));
  if (commandBlocked) return commandBlocked;
  if (args.useApi) {
    const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], stage, Boolean(args.confirmed));
    if (prerequisiteBlocked) return prerequisiteBlocked;
  }
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  try {
    const result = await getPullRequestDiffWithGh(root, {
      pr: args.githubPr,
      env: loadRuntimeEnv(root),
      dryRun: false,
      useApi: Boolean(args.useApi),
      engine,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
    if (result.status !== "fetched") {
      return {
        ...result,
        stage: result.stage || stage
      };
    }
    return result.diff;
  } catch (error) {
    return {
      status: "failed",
      stage,
      error: error.message
    };
  }
}

async function readGitHubPrHead(root, args = {}, stage = "github_pr_head_policy") {
  if (!args.githubPr) return null;
  const command = `gh pr view ${args.githubPr} --json headRefOid,headRefName`;
  const commandBlocked = githubPrerequisitePolicy(root, [command], stage, Boolean(args.confirmed));
  if (commandBlocked) return commandBlocked;
  if (args.useApi) {
    const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], stage, Boolean(args.confirmed));
    if (prerequisiteBlocked) return prerequisiteBlocked;
  }
  const { config } = loadConfig(root);
  const engine = new PolicyEngine(config, { root });
  try {
    const result = await getPullRequestHeadWithGh(root, {
      pr: args.githubPr,
      env: loadRuntimeEnv(root),
      dryRun: false,
      useApi: Boolean(args.useApi),
      engine,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
    if (result.status !== "fetched" || !result.headSha) {
      return {
        ...result,
        status: result.status || "failed",
        stage: result.stage || stage
      };
    }
    return result;
  } catch (error) {
    return {
      status: "failed",
      stage,
      error: error.message
    };
  }
}

async function diffTextFromArgs(root, args = {}, engine, stage = "github_pr_diff_policy") {
  if (args.githubPr) return readGitHubPrDiff(root, args, stage);
  if (args.diffFile) {
    return readFileWithPolicy(root, args.diffFile, engine, {
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    }).content;
  }
  return args.diff || "";
}

async function callTool(name, args, root) {
  if (name === "check_policy") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    if (args.path) return engine.checkPath(args.path);
    if (args.command) return engine.checkCommand(args.command);
    if (args.patch) return engine.checkPatch(args.patch);
    throw new Error("check_policy requires path, command, or patch");
  }
  if (name === "debug_error") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const logFile = args.logFile
      ? readFileWithPolicy(root, args.logFile, engine, {
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      })
      : null;
    const logText = logFile?.content || args.log || "";
    const result = analyzeDebugLog(logText, {
      root,
      engine,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
    if (logFile) {
      result.logFileRead = {
        path: logFile.path,
        policy: logFile.policy,
        auditLog: logFile.auditLog
      };
    }
    if (args.aiPatch) {
      const ai = await generateDebugPatch({ ...result, log: logText }, loadRuntimeEnv(root), {
        root,
        engine,
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      });
      result.aiPatch = ai;
      if (ai.patch) {
        const normalizedPatch = normalizeUnifiedDiff(ai.patch);
        result.aiPatch.patch = normalizedPatch;
        result.aiPatch.validation = validateUnifiedDiff(normalizedPatch);
        result.aiPatch.policy = result.aiPatch.validation.valid
          ? engine.checkPatch(normalizedPatch)
          : { status: "deny", reason: result.aiPatch.validation.reason, files: result.aiPatch.validation.files };
        if (args.outputPatch) {
          if (result.aiPatch.policy.status !== "allow" && !(result.aiPatch.policy.status === "require_confirmation" && args.confirmed)) {
            result.aiPatch.outputPatch = {
              status: result.aiPatch.policy.status,
              stage: "patch_policy",
              path: args.outputPatch,
              policy: result.aiPatch.policy
            };
          } else if (result.aiPatch.validation.valid) {
            result.aiPatch.outputPatch = writeFileWithPolicy(root, args.outputPatch, normalizedPatch, engine, {
              confirmed: Boolean(args.confirmed),
              auditLog: args.auditLog
            });
          }
        }
      }
    }
    return result;
  }
  if (name === "fix_error") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return await runFixWorkflow({
      root,
      engine,
      logText: args.log || "",
      logFile: args.logFile,
      patchText: args.patch,
      patchFile: args.patchFile,
      testCommand: args.testCommand,
      autoTest: Boolean(args.autoTest),
      outputPatch: args.outputPatch,
      writePrBody: args.writePrBody,
      createBranch: Boolean(args.createBranch),
      commit: Boolean(args.commit),
      push: Boolean(args.push),
      prDryRun: Boolean(args.prDryRun),
      createPr: Boolean(args.createPr),
      executeGitPlan: Boolean(args.executeGitPlan),
      checkCi: Boolean(args.checkCi),
      workflow: args.workflow,
      ciLimit: args.ciLimit,
      waitCi: Boolean(args.waitCi),
      ciWaitTimeoutMs: secondsToMs(args.ciWaitTimeout),
      ciWaitIntervalMs: secondsToMs(args.ciWaitInterval),
      prBodyFile: args.prBodyFile,
      dryRun: args.dryRun !== false,
      apply: Boolean(args.apply),
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog,
      env: loadRuntimeEnv(root),
      githubUseApi: Boolean(args.githubUseApi)
    });
  }
  if (name === "onboard_repo") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return analyzeRepository({
      root,
      engine,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
  }
  if (name === "write_tests") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    if (args.write) {
      return await writeSuggestedTestsAsync(root, engine, {
        limit: args.limit || 1,
        coverageFile: args.coverageFile,
        coverageText: args.coverageText,
        coverageAfterFile: args.coverageAfterFile,
        coverageAfterText: args.coverageAfterText,
        coverageCommand: args.coverageCommand,
        runTests: Boolean(args.run),
        repairFailures: Boolean(args.repair),
        testCommand: args.testCommand,
        createBranch: Boolean(args.createBranch),
        commit: Boolean(args.commit),
        push: Boolean(args.push),
        prDryRun: Boolean(args.prDryRun),
        createPr: Boolean(args.createPr),
        executeGitPlan: Boolean(args.executeGitPlan),
        checkCi: Boolean(args.checkCi),
        workflow: args.workflow,
        ciLimit: args.ciLimit,
        waitCi: Boolean(args.waitCi),
        ciWaitTimeoutMs: secondsToMs(args.ciWaitTimeout),
        ciWaitIntervalMs: secondsToMs(args.ciWaitInterval),
        branch: args.branch,
        commitMessage: args.commitMessage,
        prTitle: args.prTitle,
        prBodyFile: args.prBodyFile,
        dryRun: Boolean(args.dryRun),
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog,
        env: loadRuntimeEnv(root),
        githubUseApi: Boolean(args.githubUseApi)
      });
    }
    return analyzeTestTargets({
      root,
      engine,
      coverageFile: args.coverageFile,
      coverageText: args.coverageText,
      coverageAfterFile: args.coverageAfterFile,
      coverageAfterText: args.coverageAfterText,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
  }
  if (name === "review_pr") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const diffText = await diffTextFromArgs(root, args, engine, "review_pr_github_diff_policy");
    if (typeof diffText !== "string") return diffText;
    const commentPr = args.commentPr || (args.publishComment ? args.githubPr : null);
    if (args.publishComment && !commentPr) {
      throw new Error("review_pr publishComment requires githubPr or commentPr");
    }
    if (commentPr) {
      return await publishReviewComment(root, diffText, engine, {
        pr: commentPr,
        writeComment: args.writeComment,
        execute: Boolean(args.execute),
        useApi: Boolean(args.useApi),
        env: loadRuntimeEnv(root),
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog,
        stage: "review_pr_comment_policy",
        prerequisiteStage: "review_pr_comment_prerequisite_policy"
      });
    }
    if (args.writeComment) {
      return writeReviewComment(root, diffText, args.writeComment, engine, {
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      });
    }
    return analyzeReviewDiff(diffText);
  }
  if (name === "apply_patch_safely") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return applyPatchWithPolicy(root, args.patch, engine, {
      checkOnly: args.apply !== true,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
  }
  if (name === "summarize_pr") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const diffText = await diffTextFromArgs(root, args, engine, "summarize_pr_github_diff_policy");
    if (typeof diffText !== "string") return diffText;
    if (args.writeBody) {
      return writePrSummaryBody(root, diffText, args.writeBody, engine, {
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      });
    }
    return buildPrSummary(diffText);
  }
  if (name === "plan_pr") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const diffText = await diffTextFromArgs(root, args, engine, "plan_pr_github_diff_policy");
    if (typeof diffText !== "string") return diffText;
    return await buildPrPlanWorkflow(root, diffText, engine, {
      title: args.title,
      branch: args.branch,
      commitMessage: args.commitMessage,
      bodyFile: args.bodyFile,
      writeBody: args.writeBody,
      createBranch: args.createBranch !== false,
      commit: args.commit !== false,
      push: Boolean(args.push),
      prDryRun: args.prDryRun !== false,
      executeGitPlan: Boolean(args.executeGitPlan),
      checkCi: Boolean(args.checkCi),
      workflow: args.workflow,
      ciLimit: args.ciLimit,
      waitCi: Boolean(args.waitCi),
      ciWaitTimeoutMs: secondsToMs(args.ciWaitTimeout),
      ciWaitIntervalMs: secondsToMs(args.ciWaitInterval),
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog,
      env: loadRuntimeEnv(root),
      githubUseApi: Boolean(args.githubUseApi || args.useApi),
      dryRun: Boolean(args.dryRun)
    });
  }
  if (name === "detect_github") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const blocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_detect_policy", Boolean(args.confirmed));
    if (blocked) return blocked;
    return detectGitHubRepository(root, {
      engine,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
  }
  if (name === "github_auth") {
    return inspectGithubAuth({
      root,
      env: loadRuntimeEnv(root),
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
  }
  if (name === "github_pr") {
    const env = loadRuntimeEnv(root);
    const bodyFileBlocked = githubBodyFilePolicy(root, args.bodyFile, "github_pr_body_file_policy", Boolean(args.confirmed));
    if (bodyFileBlocked) return bodyFileBlocked;
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const executionPolicyOptions = {
      engine,
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    };
    const dryRun = await createPullRequestWithGh(root, {
      title: args.title,
      bodyFile: args.bodyFile,
      body: args.body,
      base: args.base,
      head: args.head,
      draft: Boolean(args.draft),
      useApi: Boolean(args.useApi),
      env,
      dryRun: true
    });
    if (args.execute === true) {
      const policy = engine.checkCommand(dryRun.command);
      if (policy.status !== "allow" && !(policy.status === "require_confirmation" && args.confirmed)) {
        return {
          status: policy.status,
          stage: "github_pr_policy",
          command: dryRun.command,
          policy
        };
      }
      const prerequisites = [GITHUB_DETECT_COMMAND];
      if (!args.head) prerequisites.push(GITHUB_CURRENT_BRANCH_COMMAND);
      const prerequisiteBlocked = githubPrerequisitePolicy(root, prerequisites, "github_pr_prerequisite_policy", Boolean(args.confirmed));
      if (prerequisiteBlocked) return prerequisiteBlocked;
    }
    return createPullRequestWithGh(root, {
      title: args.title,
      bodyFile: args.bodyFile,
      body: args.body,
      base: args.base,
      head: args.head,
      draft: Boolean(args.draft),
      useApi: Boolean(args.useApi),
      env,
      dryRun: args.execute !== true,
      ...executionPolicyOptions
    });
  }
  if (name === "github_comment") {
    const env = loadRuntimeEnv(root);
    const bodyFileBlocked = githubBodyFilePolicy(root, args.bodyFile, "github_comment_body_file_policy", Boolean(args.confirmed));
    if (bodyFileBlocked) return bodyFileBlocked;
    const dryRun = await commentPullRequestWithGh(root, {
      pr: args.pr,
      bodyFile: args.bodyFile,
      body: args.body,
      useApi: Boolean(args.useApi),
      env,
      dryRun: true
    });
    const executionPolicyOptions = {};
    if (args.execute === true) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      executionPolicyOptions.engine = engine;
      executionPolicyOptions.confirmed = Boolean(args.confirmed);
      executionPolicyOptions.auditLog = args.auditLog;
      const policy = engine.checkCommand(dryRun.command);
      if (policy.status !== "allow" && !(policy.status === "require_confirmation" && args.confirmed)) {
        return {
          status: policy.status,
          stage: "github_comment_policy",
          command: dryRun.command,
          policy
        };
      }
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_comment_prerequisite_policy", Boolean(args.confirmed));
      if (prerequisiteBlocked) return prerequisiteBlocked;
    }
    return commentPullRequestWithGh(root, {
      pr: args.pr,
      bodyFile: args.bodyFile,
      body: args.body,
      useApi: Boolean(args.useApi),
      env,
      dryRun: args.execute !== true,
      ...executionPolicyOptions
    });
  }
  if (name === "github_review_comment") {
    const env = loadRuntimeEnv(root);
    const bodyFileBlocked = githubBodyFilePolicy(root, args.bodyFile, "github_review_comment_body_file_policy", Boolean(args.confirmed));
    if (bodyFileBlocked) return bodyFileBlocked;
    const options = {
      pr: args.pr,
      bodyFile: args.bodyFile,
      body: args.body,
      commitId: args.commitId,
      path: args.path,
      line: args.line,
      side: args.side,
      startLine: args.startLine,
      startSide: args.startSide,
      subjectType: args.subjectType,
      useApi: Boolean(args.useApi),
      env
    };
    const dryRun = await createReviewCommentWithGh(root, {
      ...options,
      dryRun: true
    });
    const executionPolicyOptions = {};
    if (args.execute === true) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      executionPolicyOptions.engine = engine;
      executionPolicyOptions.confirmed = Boolean(args.confirmed);
      executionPolicyOptions.auditLog = args.auditLog;
      const policy = engine.checkCommand(dryRun.command);
      if (policy.status !== "allow" && !(policy.status === "require_confirmation" && args.confirmed)) {
        return {
          status: policy.status,
          stage: "github_review_comment_policy",
          command: dryRun.command,
          policy
        };
      }
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_review_comment_prerequisite_policy", Boolean(args.confirmed));
      if (prerequisiteBlocked) return prerequisiteBlocked;
    }
    return createReviewCommentWithGh(root, {
      ...options,
      dryRun: args.execute !== true,
      ...executionPolicyOptions
    });
  }
  if (name === "github_review_comments") {
    const env = loadRuntimeEnv(root);
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const diffText = await diffTextFromArgs(root, args, engine, "github_review_comments_diff_policy");
    if (typeof diffText !== "string") return diffText;
    let commitId = args.commitId;
    let head = null;
    if (!commitId && args.githubPr) {
      head = await readGitHubPrHead(root, args, "github_review_comments_pr_head_policy");
      if (!head || head.status !== "fetched") return head;
      commitId = head.headSha;
    }
    const review = analyzeReviewDiff(diffText);
    const dryRun = await createReviewCommentsWithGh(root, {
      pr: args.pr,
      commitId,
      comments: review.reviewComments,
      limit: args.limit,
      useApi: Boolean(args.useApi),
      env,
      dryRun: true
    });
    const commandPolicy = checkGitHubCommandsPolicy(dryRun.comments, engine, {
      confirmed: Boolean(args.confirmed),
      stage: "github_review_comments_policy"
    });
    if (args.execute === true && commandPolicy.status !== "allow") {
      return {
        ...commandPolicy,
        review,
        head,
        publish: dryRun
      };
    }
    if (args.execute === true) {
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_review_comments_prerequisite_policy", Boolean(args.confirmed));
      if (prerequisiteBlocked) {
        return {
          ...prerequisiteBlocked,
          review,
          head,
          publish: dryRun
        };
      }
    }
    const publish = args.execute === true
      ? await createReviewCommentsWithGh(root, {
        pr: args.pr,
        commitId,
        comments: review.reviewComments,
        limit: args.limit,
        useApi: Boolean(args.useApi),
        env,
        dryRun: false,
        engine,
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      })
      : dryRun;
    return {
      status: publish.status,
      head,
      review,
      commandPolicy,
      publish
    };
  }
  if (name === "github_checks") {
    const options = {
      branch: args.branch,
      workflow: args.workflow,
      limit: args.limit,
      wait: Boolean(args.wait),
      waitTimeoutMs: secondsToMs(args.waitTimeout),
      waitIntervalMs: secondsToMs(args.waitInterval),
      useApi: Boolean(args.useApi),
      env: loadRuntimeEnv(root),
      dryRun: true
    };
    const dryRun = await listWorkflowRunsWithGh(root, options);
    if (args.execute === true) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      const commandPolicy = checkGitHubCommandsPolicy([{ index: 1, command: dryRun.command }], engine, {
        confirmed: Boolean(args.confirmed),
        stage: "github_checks_policy"
      });
      if (commandPolicy.status !== "allow") {
        return {
          ...commandPolicy,
          dryRun
        };
      }
      const prerequisiteBlocked = githubPrerequisitePolicy(root, [GITHUB_DETECT_COMMAND], "github_checks_prerequisite_policy", Boolean(args.confirmed));
      if (prerequisiteBlocked) {
        return {
          ...prerequisiteBlocked,
          dryRun
        };
      }
      const result = await listWorkflowRunsWithGh(root, {
        ...options,
        dryRun: false,
        engine,
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      });
      return {
        ...result,
        commandPolicy
      };
    }
    return dryRun;
  }
  if (name === "eval_fixtures") {
    return evaluateFixFixtures({
      root,
      fixture: args.fixture,
      repeat: args.repeat,
      apply: Boolean(args.apply),
      output: args.output,
      history: args.history,
      confirmed: Boolean(args.confirmed),
      env: loadRuntimeEnv(root)
    });
  }
  if (name === "eval_history") {
    return summarizeEvalHistory({
      root,
      file: args.file,
      limit: args.limit,
      confirmed: Boolean(args.confirmed)
    });
  }
  if (name === "doctor") return runDoctor({ root, env: loadRuntimeEnv(root) });
  if (name === "audit_summary") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const auditFile = readFileWithPolicy(root, args.file || "reports/audit.jsonl", engine, {
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
    return {
      ...summarizeAuditEvents(auditFile.content, { limit: args.limit }),
      audit: {
        path: auditFile.path,
        policy: auditFile.policy,
        auditLog: auditFile.auditLog
      }
    };
  }
  if (name === "audit_report") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    const auditFile = readFileWithPolicy(root, args.file || "reports/audit.jsonl", engine, {
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog
    });
    const summary = {
      ...summarizeAuditEvents(auditFile.content, { limit: args.limit }),
      audit: {
        path: auditFile.path,
        policy: auditFile.policy,
        auditLog: auditFile.auditLog
      }
    };
    return {
      ...summary,
      report: writeFileWithPolicy(root, args.output, buildAuditMarkdown(summary), engine, {
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      })
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleMcpRequest(request, root = process.cwd()) {
  const isNotification = request.id === undefined || request.id === null;
  if (request.method === "notifications/initialized") return null;
  if (request.method === "notifications/cancelled") return null;
  if (isNotification && String(request.method || "").startsWith("notifications/")) return null;
  if (request.method === "ping") return ok(request.id, {});
  if (request.method === "initialize") return ok(request.id, initializeResult(request.params || {}));
  if (request.method === "tools/list") return ok(request.id, { tools });
  if (request.method === "resources/list") return ok(request.id, { resources });
  if (request.method === "resources/templates/list") return ok(request.id, { resourceTemplates });
  if (request.method === "resources/read") {
    try {
      return ok(request.id, readMcpResource(root, request.params?.uri, request.params?.arguments || {}));
    } catch (error) {
      return fail(request.id, error);
    }
  }
  if (request.method === "prompts/list") return ok(request.id, { prompts });
  if (request.method === "prompts/get") {
    try {
      return ok(request.id, getPrompt(request.params?.name, request.params?.arguments || {}));
    } catch (error) {
      return fail(request.id, error);
    }
  }
  if (request.method === "logging/setLevel") return ok(request.id, {});
  if (request.method === "tools/call") {
    try {
      const name = request.params?.name;
      const args = validateToolArguments(name, request.params?.arguments ?? {});
      const result = await callTool(name, args, root);
      return ok(request.id, toolContent(result));
    } catch (error) {
      return ok(request.id, toolErrorContent(error));
    }
  }
  return fail(request.id, new Error(`Unsupported method: ${request.method}`));
}

export async function startMcpServer(options = {}) {
  const root = options.root || process.cwd();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      const response = await handleMcpRequest(request, root);
      if (response) console.log(JSON.stringify(response));
    } catch (error) {
      console.log(JSON.stringify(fail(request?.id ?? null, error)));
    }
  }
}

export const mcpInternals = {
  tools,
  resources,
  resourceTemplates,
  prompts,
  initializeResult,
  toolContent,
  toolErrorContent,
  readMcpResource,
  getPrompt,
  validateToolArguments,
  callTool
};
