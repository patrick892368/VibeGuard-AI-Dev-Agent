import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loadConfig.js";
import { detectGitHubRepository } from "../integrations/github.js";

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
  return {
    provider,
    model,
    hasGrokKey: Boolean(env.XAI_API_KEY || env.GROK_API_KEY),
    hasOpenAIKey: Boolean(env.OPENAI_API_KEY)
  };
}

function gitConfigValue(root, key) {
  try {
    return execFileSync("git", ["config", "--get", key], { cwd: root, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function runDoctor(options = {}) {
  const root = options.root || process.cwd();
  const env = options.env || process.env;
  let policy;
  try {
    const loaded = loadConfig(root);
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
    github = {
      status: "detected",
      ...detectGitHubRepository(root)
    };
  } catch (error) {
    github = {
      status: "unavailable",
      error: error.message
    };
  }

  return {
    status: "completed",
    root,
    policy,
    tools: {
      git: commandAvailable("git", ["--version"]),
      gh: commandAvailable("gh", ["--version"])
    },
    github,
    githubAuth: {
      hasToken: Boolean(env.GITHUB_TOKEN || env.GH_TOKEN)
    },
    provider: providerStatus(env),
    proxy: {
      https: env.VIBEGUARD_HTTPS_PROXY || env.HTTPS_PROXY || env.https_proxy || null,
      http: env.HTTP_PROXY || env.http_proxy || null,
      gitHttp: gitConfigValue(root, "http.proxy"),
      gitHttps: gitConfigValue(root, "https.proxy")
    }
  };
}
