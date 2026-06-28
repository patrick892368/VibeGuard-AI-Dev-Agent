import { execFileSync } from "node:child_process";
import { gitConfigValue } from "../config/env.js";
import { loadConfig } from "../config/loadConfig.js";
import { detectGitHubRepository } from "../integrations/github.js";
import { PolicyEngine } from "../policy/engine.js";

function commandAvailable(command, args = ["--version"]) {
  try {
    const stdout = execFileSync(command, args, { encoding: "utf8" });
    return {
      available: true,
      detail: stdout.split(/\r?\n/)[0] || "available"
    };
  } catch (error) {
    return {
      available: false,
      detail: error.message
    };
  }
}

function providerStatus(env) {
  const provider = env.VIBEGUARD_LLM_PROVIDER || ((env.XAI_API_KEY || env.GROK_API_KEY) ? "grok" : "unset");
  const model = provider === "grok" || provider === "xai"
    ? env.VIBEGUARD_MODEL || env.XAI_MODEL || env.GROK_MODEL || "grok-4.3"
    : env.VIBEGUARD_MODEL || null;
  const hasGrokKey = Boolean(env.XAI_API_KEY || env.GROK_API_KEY);
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY);
  let ready = false;
  let reason = null;
  if (provider === "unset") {
    reason = "No LLM provider is configured.";
  } else if (provider === "grok" || provider === "xai") {
    ready = hasGrokKey;
    reason = ready ? null : "XAI_API_KEY or GROK_API_KEY is required for Grok.";
  } else if (provider === "openai-compatible") {
    ready = hasOpenAIKey && Boolean(env.VIBEGUARD_MODEL);
    reason = ready ? null : "OPENAI_API_KEY and VIBEGUARD_MODEL are required for openai-compatible providers.";
  } else if (provider === "fixture") {
    ready = true;
  } else {
    reason = `Unsupported LLM provider: ${provider}`;
  }
  return {
    provider,
    model,
    hasGrokKey,
    hasOpenAIKey,
    ready,
    reason
  };
}

function buildNextActions({ policy, github, githubAuth, provider, tools }) {
  const actions = [];
  if (policy.status !== "loaded") {
    actions.push({
      id: "fix_policy_config",
      reason: "Policy config did not load.",
      command: "Inspect .vibeguard.yaml"
    });
  }
  if (!provider.ready) {
    const command = provider.provider === "grok" || provider.provider === "xai" || provider.provider === "unset"
      ? "Set XAI_API_KEY or GROK_API_KEY and VIBEGUARD_LLM_PROVIDER=grok"
      : "Set OPENAI_API_KEY and VIBEGUARD_MODEL";
    actions.push({
      id: "configure_ai_provider",
      reason: provider.reason,
      command
    });
  }
  if (github.status !== "detected") {
    actions.push({
      id: "configure_github_remote",
      reason: "origin is not a detected GitHub remote.",
      command: "git remote add origin https://github.com/<owner>/<repo>.git"
    });
  }
  if (!tools.gh.available && !githubAuth.hasToken) {
    actions.push({
      id: "enable_github_execution",
      reason: "Neither gh CLI nor GITHUB_TOKEN/GH_TOKEN is available for real GitHub PR/comment/check execution.",
      command: "Install and authenticate gh, or set GITHUB_TOKEN/GH_TOKEN"
    });
  }
  return actions;
}

export function runDoctor(options = {}) {
  const root = options.root || process.cwd();
  const env = options.env || process.env;
  let policy;
  let engine = null;
  try {
    const loaded = loadConfig(root);
    engine = new PolicyEngine(loaded.config, { root });
    policy = {
      status: "loaded",
      path: loaded.configPath || null
    };
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
      ...detectGitHubRepository(root, { engine })
    };
  } catch (error) {
    github = {
      status: "unavailable",
      error: error.message
    };
  }

  const tools = options.toolStatus || {
    git: commandAvailable("git", ["--version"]),
    gh: commandAvailable("gh", ["--version"])
  };
  const githubAuth = {
    hasToken: Boolean(env.GITHUB_TOKEN || env.GH_TOKEN)
  };
  const provider = providerStatus(env);
  const result = {
    status: "completed",
    root,
    policy,
    tools,
    github,
    githubAuth,
    provider,
    proxy: {
      https: env.VIBEGUARD_HTTPS_PROXY || env.HTTPS_PROXY || env.https_proxy || null,
      http: env.HTTP_PROXY || env.http_proxy || null,
      gitHttp: gitConfigValue(root, "http.proxy"),
      gitHttps: gitConfigValue(root, "https.proxy")
    }
  };
  return {
    ...result,
    nextActions: buildNextActions(result)
  };
}
