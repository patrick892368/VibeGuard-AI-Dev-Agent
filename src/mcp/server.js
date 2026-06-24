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
import { analyzeTestTargets, writeSuggestedTests } from "../agents/testWriter.js";
import { analyzeReviewDiff, writeReviewComment } from "../agents/review.js";
import { buildPrSummary, writePrSummaryBody } from "../agents/pr.js";
import { commentPullRequestWithGh, createPullRequestWithGh, detectGitHubRepository, listWorkflowRunsWithGh } from "../integrations/github.js";
import { evaluateFixFixtures, summarizeEvalHistory } from "../eval/fixtures.js";
import { applyPatchWithPolicy } from "../patch/safeApply.js";

const stringSchema = { type: "string" };
const booleanSchema = { type: "boolean" };
const numberSchema = { type: "number" };

function objectSchema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
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
    description: "Parse an error log and return likely files, stack frames, and fix hints.",
    inputSchema: objectSchema({
      log: stringSchema
    })
  },
  {
    name: "fix_error",
    description: "Run the safe fix workflow: debug log, patch validation, policy check, optional apply, tests, and PR summary.",
    inputSchema: objectSchema({
      log: stringSchema,
      patch: stringSchema,
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
    inputSchema: objectSchema()
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
      run: booleanSchema,
      testCommand: stringSchema,
      createBranch: booleanSchema,
      commit: booleanSchema,
      push: booleanSchema,
      prDryRun: booleanSchema,
      createPr: booleanSchema,
      executeGitPlan: booleanSchema,
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
      writeComment: stringSchema,
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
      writeBody: stringSchema,
      confirmed: booleanSchema,
      auditLog: stringSchema
    })
  },
  {
    name: "detect_github",
    description: "Detect the GitHub origin repository for the current repo.",
    inputSchema: objectSchema()
  },
  {
    name: "github_pr",
    description: "Create a GitHub PR through gh pr create. Dry-run by default.",
    inputSchema: objectSchema({
      title: stringSchema,
      bodyFile: stringSchema,
      body: stringSchema,
      base: stringSchema,
      head: stringSchema,
      draft: booleanSchema,
      execute: booleanSchema,
      confirmed: booleanSchema
    })
  },
  {
    name: "github_checks",
    description: "Read recent GitHub Actions workflow run status through gh run list.",
    inputSchema: objectSchema({
      branch: stringSchema,
      workflow: stringSchema,
      limit: numberSchema,
      execute: booleanSchema
    })
  },
  {
    name: "github_comment",
    description: "Create a GitHub PR comment through gh pr comment. Dry-run by default.",
    inputSchema: objectSchema({
      pr: stringSchema,
      bodyFile: stringSchema,
      body: stringSchema,
      execute: booleanSchema,
      confirmed: booleanSchema
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
      tools: {}
    },
    serverInfo: {
      name: "vibeguard-ai-dev-agent",
      version: "0.1.0"
    }
  };
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
    return analyzeDebugLog(args.log || "", { root, engine });
  }
  if (name === "fix_error") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return await runFixWorkflow({
      root,
      engine,
      logText: args.log || "",
      patchText: args.patch,
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
      prBodyFile: args.prBodyFile,
      dryRun: args.dryRun !== false,
      apply: Boolean(args.apply),
      confirmed: Boolean(args.confirmed),
      auditLog: args.auditLog,
      env: loadRuntimeEnv(root)
    });
  }
  if (name === "onboard_repo") return analyzeRepository({ root });
  if (name === "write_tests") {
    if (args.write) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      return writeSuggestedTests(root, engine, {
        limit: args.limit || 1,
        coverageFile: args.coverageFile,
        coverageText: args.coverageText,
        coverageAfterFile: args.coverageAfterFile,
        coverageAfterText: args.coverageAfterText,
        runTests: Boolean(args.run),
        testCommand: args.testCommand,
        createBranch: Boolean(args.createBranch),
        commit: Boolean(args.commit),
        push: Boolean(args.push),
        prDryRun: Boolean(args.prDryRun),
        createPr: Boolean(args.createPr),
        executeGitPlan: Boolean(args.executeGitPlan),
        branch: args.branch,
        commitMessage: args.commitMessage,
        prTitle: args.prTitle,
        prBodyFile: args.prBodyFile,
        dryRun: Boolean(args.dryRun),
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      });
    }
    return analyzeTestTargets({
      root,
      coverageFile: args.coverageFile,
      coverageText: args.coverageText,
      coverageAfterFile: args.coverageAfterFile,
      coverageAfterText: args.coverageAfterText
    });
  }
  if (name === "review_pr") {
    if (args.writeComment) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      return writeReviewComment(root, args.diff || "", args.writeComment, engine, {
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      });
    }
    return analyzeReviewDiff(args.diff || "");
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
    if (args.writeBody) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      return writePrSummaryBody(root, args.diff || "", args.writeBody, engine, {
        confirmed: Boolean(args.confirmed),
        auditLog: args.auditLog
      });
    }
    return buildPrSummary(args.diff || "");
  }
  if (name === "detect_github") return detectGitHubRepository(root);
  if (name === "github_pr") {
    const env = loadRuntimeEnv(root);
    const dryRun = await createPullRequestWithGh(root, {
      title: args.title,
      bodyFile: args.bodyFile,
      body: args.body,
      base: args.base,
      head: args.head,
      draft: Boolean(args.draft),
      env,
      dryRun: true
    });
    if (args.execute === true) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      const policy = engine.checkCommand(dryRun.command);
      if (policy.status !== "allow" && !(policy.status === "require_confirmation" && args.confirmed)) {
        return {
          status: policy.status,
          stage: "github_pr_policy",
          command: dryRun.command,
          policy
        };
      }
    }
    return createPullRequestWithGh(root, {
      title: args.title,
      bodyFile: args.bodyFile,
      body: args.body,
      base: args.base,
      head: args.head,
      draft: Boolean(args.draft),
      env,
      dryRun: args.execute !== true
    });
  }
  if (name === "github_comment") {
    const env = loadRuntimeEnv(root);
    const dryRun = await commentPullRequestWithGh(root, {
      pr: args.pr,
      bodyFile: args.bodyFile,
      body: args.body,
      env,
      dryRun: true
    });
    if (args.execute === true) {
      const { config } = loadConfig(root);
      const engine = new PolicyEngine(config, { root });
      const policy = engine.checkCommand(dryRun.command);
      if (policy.status !== "allow" && !(policy.status === "require_confirmation" && args.confirmed)) {
        return {
          status: policy.status,
          stage: "github_comment_policy",
          command: dryRun.command,
          policy
        };
      }
    }
    return commentPullRequestWithGh(root, {
      pr: args.pr,
      bodyFile: args.bodyFile,
      body: args.body,
      env,
      dryRun: args.execute !== true
    });
  }
  if (name === "github_checks") {
    return listWorkflowRunsWithGh(root, {
      branch: args.branch,
      workflow: args.workflow,
      limit: args.limit,
      env: loadRuntimeEnv(root),
      dryRun: args.execute !== true
    });
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
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") return ok(request.id, initializeResult(request.params || {}));
  if (request.method === "tools/list") return ok(request.id, { tools });
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
  initializeResult,
  toolContent,
  toolErrorContent,
  validateToolArguments,
  callTool
};
