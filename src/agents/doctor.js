import { gitConfigValue } from "../config/env.js";
import { loadConfig } from "../config/loadConfig.js";
import { detectGitHubRepository } from "../integrations/github.js";
import { PolicyEngine } from "../policy/engine.js";
import { commandDisplay, runArgvWithPolicy } from "../runner/safeCommand.js";

function firstLine(...texts) {
  for (const text of texts) {
    const line = String(text || "").split(/\r?\n/).find(Boolean);
    if (line) return line;
  }
  return null;
}

function commandAvailable(root, argv, engine) {
  const command = commandDisplay(argv);
  if (!engine) {
    return {
      available: false,
      command,
      detail: "Policy config did not load; command probe skipped."
    };
  }
  try {
    const result = runArgvWithPolicy(root, argv, engine);
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

function capability(id, title, titleZh, status, reason = null, details = {}) {
  return {
    id,
    title,
    titleZh,
    status,
    ready: status === "ready",
    reason,
    ...details
  };
}

function buildCapabilityReadiness({ policy, github, githubAuth, provider, tools }) {
  const policyReady = policy.status === "loaded";
  const providerReady = provider.ready;
  const githubRemoteReady = github.status === "detected";
  const githubExecutionReady = githubRemoteReady && (tools.gh.available || githubAuth.hasToken);
  const grokProvider = provider.provider === "grok" || provider.provider === "xai";
  const capabilities = [
    capability(
      "policy_as_code",
      "Policy-as-Code safety base",
      "Policy-as-Code 安全底座",
      policyReady ? "ready" : "blocked",
      policyReady ? null : "Policy config failed to load."
    ),
    capability(
      "ai_debug_agent",
      "AI Debug Agent",
      "AI Debug Agent",
      !policyReady ? "blocked" : providerReady ? "ready" : "partial",
      !policyReady
        ? "Policy is required before reading logs, generating patches, applying patches, or running tests."
        : providerReady
          ? null
          : "Log parsing and repair plans are available, but AI patch generation needs a configured provider."
    ),
    capability(
      "repo_onboarding_agent",
      "AI Repo Onboarding Agent",
      "AI Repo Onboarding Agent",
      policyReady ? "ready" : "blocked",
      policyReady ? null : "Repository metadata reads must pass policy before onboarding."
    ),
    capability(
      "test_writer_agent",
      "AI Test Writer Agent",
      "AI Test Writer Agent",
      policyReady ? "ready" : "blocked",
      policyReady ? null : "Source reads, generated test writes, and test commands must pass policy."
    ),
    capability(
      "pr_review_agent",
      "AI PR Review Agent",
      "AI PR Review Agent",
      policyReady ? "ready" : "blocked",
      policyReady ? null : "Diff reads, comment writes, and publish commands must pass policy."
    ),
    capability(
      "codex_grok_integration",
      "Codex + Grok integration",
      "Codex + Grok 集成",
      providerReady && grokProvider ? "ready" : providerReady ? "partial" : "blocked",
      providerReady && grokProvider
        ? null
        : providerReady
          ? "A provider is configured, but it is not the current priority Grok/xAI provider."
          : provider.reason,
      { provider: provider.provider, model: provider.model }
    ),
    capability(
      "github_pr_loop",
      "GitHub PR loop",
      "GitHub PR 闭环",
      githubExecutionReady ? "ready" : githubRemoteReady ? "partial" : "blocked",
      githubExecutionReady
        ? null
        : githubRemoteReady
          ? "GitHub remote is detected, but real PR/comment/check execution needs authenticated gh or GITHUB_TOKEN/GH_TOKEN."
          : "A GitHub origin remote is required for PR creation, comments, review comments, and CI checks.",
      {
        hasRemote: githubRemoteReady,
        hasGh: Boolean(tools.gh.available),
        hasToken: Boolean(githubAuth.hasToken)
      }
    )
  ];
  const counts = capabilities.reduce((summary, item) => {
    summary[item.status] = (summary[item.status] || 0) + 1;
    return summary;
  }, { ready: 0, partial: 0, blocked: 0 });
  return {
    status: counts.blocked > 0 ? "blocked" : counts.partial > 0 ? "partial" : "ready",
    counts,
    capabilities
  };
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
    git: commandAvailable(root, ["git", "--version"], engine),
    gh: commandAvailable(root, ["gh", "--version"], engine)
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
    capabilityReadiness: buildCapabilityReadiness(result),
    nextActions: buildNextActions(result)
  };
}
