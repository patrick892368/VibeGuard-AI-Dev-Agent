import { loadConfig } from "../config/loadConfig.js";
import { PolicyEngine } from "../policy/engine.js";
import { commandDisplay, runArgvWithPolicy } from "../runner/safeCommand.js";
import { detectGitHubRepository } from "./github.js";

export function firstLine(...texts) {
  for (const text of texts) {
    const line = String(text || "").split(/\r?\n/).find(Boolean);
    if (line) return line;
  }
  return null;
}

export function commandAvailable(root, argv, engine, options = {}) {
  const command = commandDisplay(argv);
  if (!engine) {
    return {
      available: false,
      command,
      detail: "Policy config did not load; command probe skipped."
    };
  }
  try {
    const result = runArgvWithPolicy(root, argv, engine, {
      confirmed: options.confirmed,
      auditLog: options.auditLog
    });
    return {
      available: result.exitCode === 0,
      command,
      detail: firstLine(result.stdout, result.stderr, result.error) || (result.exitCode === 0 ? "available" : "unavailable"),
      policyStatus: result.policy.status
    };
  } catch (error) {
    return {
      available: false,
      command,
      detail: error.message
    };
  }
}

export function probeGhAuth(root, tools, engine, options = {}) {
  const command = commandDisplay(["gh", "auth", "status"]);
  if (!tools.gh.available) {
    return {
      available: false,
      authenticated: false,
      command,
      detail: "gh CLI is not available."
    };
  }
  if (!engine) {
    return {
      available: true,
      authenticated: false,
      command,
      detail: "Policy config did not load; gh auth probe skipped."
    };
  }
  try {
    const result = runArgvWithPolicy(root, ["gh", "auth", "status"], engine, {
      confirmed: options.confirmed,
      auditLog: options.auditLog
    });
    return {
      available: true,
      authenticated: result.exitCode === 0,
      command,
      detail: firstLine(result.stdout, result.stderr, result.error) || (result.exitCode === 0 ? "authenticated" : "not authenticated"),
      policyStatus: result.policy.status
    };
  } catch (error) {
    return {
      available: true,
      authenticated: false,
      command,
      detail: error.message
    };
  }
}

export function githubAuthStatus(env = process.env, ghAuth = {}) {
  const tokenSources = [
    { name: "GITHUB_TOKEN", present: Boolean(env.GITHUB_TOKEN) },
    { name: "GH_TOKEN", present: Boolean(env.GH_TOKEN) }
  ];
  const hasToken = tokenSources.some((source) => source.present);
  return {
    hasToken,
    tokenSources,
    gh: ghAuth,
    canWrite: hasToken || Boolean(ghAuth.authenticated)
  };
}

export function buildGithubAuthNextActions({ policy, github, githubAuth }) {
  const actions = [];
  if (policy.status !== "loaded") {
    actions.push({
      id: "fix_policy_config",
      reason: "Policy config did not load.",
      command: "Inspect .vibeguard.yaml"
    });
  }
  if (github.status !== "detected") {
    actions.push({
      id: "configure_github_remote",
      reason: "origin is not a detected GitHub remote.",
      command: "git remote add origin https://github.com/<owner>/<repo>.git"
    });
  }
  if (!githubAuth.canWrite) {
    actions.push({
      id: "enable_github_execution",
      reason: "Neither an authenticated gh CLI nor GITHUB_TOKEN/GH_TOKEN is available for real GitHub PR/comment/review-comment writes.",
      command: "Install and authenticate gh with `gh auth login`, or set GITHUB_TOKEN/GH_TOKEN"
    });
  }
  return actions;
}

export function inspectGithubAuth(options = {}) {
  const root = options.root || process.cwd();
  const env = options.env || process.env;
  let policy;
  let engine = options.engine || null;
  try {
    if (!engine) {
      const loaded = loadConfig(root);
      engine = new PolicyEngine(loaded.config, { root });
      policy = {
        status: "loaded",
        path: loaded.configPath || null
      };
    } else {
      policy = {
        status: "loaded",
        path: options.configPath || null
      };
    }
  } catch (error) {
    policy = {
      status: "failed",
      error: error.message
    };
  }

  let github;
  try {
    if (!engine) {
      throw new Error("Policy config did not load; GitHub remote detection was skipped.");
    }
    github = {
      status: "detected",
      ...detectGitHubRepository(root, {
        engine,
        confirmed: Boolean(options.confirmed),
        auditLog: options.auditLog
      })
    };
  } catch (error) {
    github = {
      status: "unavailable",
      error: error.message
    };
  }

  const tools = options.toolStatus || {
    gh: commandAvailable(root, ["gh", "--version"], engine, options)
  };
  const githubAuth = githubAuthStatus(env, options.ghAuthStatus || probeGhAuth(root, tools, engine, options));
  const result = {
    status: "completed",
    root,
    policy,
    github,
    tools,
    githubAuth
  };
  return {
    ...result,
    nextActions: buildGithubAuthNextActions(result)
  };
}
