import readline from "node:readline";
import { loadConfig } from "../config/loadConfig.js";
import { loadRuntimeEnv } from "../config/env.js";
import { PolicyEngine } from "../policy/engine.js";
import { analyzeDebugLog } from "../agents/debug.js";
import { runFixWorkflow } from "../agents/fix.js";
import { analyzeRepository } from "../agents/onboard.js";
import { analyzeTestTargets } from "../agents/testWriter.js";
import { analyzeReviewDiff } from "../agents/review.js";
import { buildPrSummary } from "../agents/pr.js";
import { detectGitHubRepository } from "../integrations/github.js";
import { evaluateFixFixtures, summarizeEvalHistory } from "../eval/fixtures.js";

const tools = [
  {
    name: "check_policy",
    description: "Check a file path, command, or patch against .vibeguard.yaml policy."
  },
  {
    name: "debug_error",
    description: "Parse an error log and return likely files, stack frames, and fix hints."
  },
  {
    name: "fix_error",
    description: "Run the safe fix workflow: debug log, patch validation, policy check, optional apply, tests, and PR summary."
  },
  {
    name: "onboard_repo",
    description: "Scan the repository and return onboarding documentation."
  },
  {
    name: "write_tests",
    description: "Find source files that are good candidates for new tests."
  },
  {
    name: "review_pr",
    description: "Analyze a unified diff for review findings."
  },
  {
    name: "summarize_pr",
    description: "Build a GitHub-ready PR summary from a unified diff."
  },
  {
    name: "detect_github",
    description: "Detect the GitHub origin repository for the current repo."
  },
  {
    name: "eval_fixtures",
    description: "Evaluate the configured LLM provider against Python and Node fix fixtures."
  },
  {
    name: "eval_history",
    description: "Summarize compact JSONL fixture evaluation history."
  }
];

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

function callTool(name, args, root) {
  if (name === "check_policy") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    if (args.path) return engine.checkPath(args.path);
    if (args.command) return engine.checkCommand(args.command);
    if (args.patch) return engine.checkPatch(args.patch);
    throw new Error("check_policy requires path, command, or patch");
  }
  if (name === "debug_error") return analyzeDebugLog(args.log || "", { root });
  if (name === "fix_error") {
    const { config } = loadConfig(root);
    const engine = new PolicyEngine(config, { root });
    return runFixWorkflow({
      root,
      engine,
      logText: args.log || "",
      patchText: args.patch,
      testCommand: args.testCommand,
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
      env: loadRuntimeEnv(root)
    });
  }
  if (name === "onboard_repo") return analyzeRepository({ root });
  if (name === "write_tests") return analyzeTestTargets({ root });
  if (name === "review_pr") return analyzeReviewDiff(args.diff || "");
  if (name === "summarize_pr") return buildPrSummary(args.diff || "");
  if (name === "detect_github") return detectGitHubRepository(root);
  if (name === "eval_fixtures") {
    return evaluateFixFixtures({
      root,
      fixture: args.fixture,
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
  throw new Error(`Unknown tool: ${name}`);
}

export async function startMcpServer(options = {}) {
  const root = options.root || process.cwd();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      if (request.method === "tools/list") {
        console.log(JSON.stringify(ok(request.id, { tools })));
      } else if (request.method === "tools/call") {
        const result = callTool(request.params?.name, request.params?.arguments || {}, root);
        console.log(JSON.stringify(ok(request.id, { content: [{ type: "json", json: result }] })));
      } else {
        console.log(JSON.stringify(fail(request.id, new Error(`Unsupported method: ${request.method}`))));
      }
    } catch (error) {
      console.log(JSON.stringify(fail(request?.id ?? null, error)));
    }
  }
}
