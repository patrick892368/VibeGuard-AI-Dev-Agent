import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appendAuditEvent } from "../policy/audit.js";
import { assertPolicyAllowed } from "../policy/safeWrite.js";

export const GITHUB_DETECT_COMMAND = "git remote get-url origin";
export const GITHUB_CURRENT_BRANCH_COMMAND = "git branch --show-current";

export function parseGitHubRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2], url: `https://github.com/${https[1]}/${https[2]}` };

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2], url: `https://github.com/${ssh[1]}/${ssh[2]}` };

  return null;
}

export function detectGitHubRepository(root = process.cwd(), options = {}) {
  checkOptionalCommandPolicy(root, GITHUB_DETECT_COMMAND, options, "github_detect");
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8" }).trim();
  const parsed = parseGitHubRemote(remote);
  if (!parsed) {
    throw new Error(`origin is not a GitHub remote: ${remote}`);
  }
  return {
    remote,
    ...parsed
  };
}

export function buildGhPrArgs(options = {}) {
  if (!options.title) throw new Error("GitHub PR title is required");
  const args = ["pr", "create", "--title", options.title];
  if (options.body) args.push("--body", options.body);
  if (options.bodyFile) args.push("--body-file", options.bodyFile);
  if (options.base) args.push("--base", options.base);
  if (options.head) args.push("--head", options.head);
  if (options.draft) args.push("--draft");
  return args;
}

export function buildGhPrCommentArgs(options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  const args = ["pr", "comment", String(options.pr)];
  if (options.bodyFile) args.push("--body-file", options.bodyFile);
  if (options.body) args.push("--body", options.body);
  if (!options.bodyFile && !options.body) throw new Error("GitHub PR comment body or bodyFile is required");
  return args;
}

export function buildGhPrReviewCommentArgs(options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  if (!options.commitId) throw new Error("GitHub PR review comment commitId is required");
  if (!options.path) throw new Error("GitHub PR review comment path is required");
  if (!options.line) throw new Error("GitHub PR review comment line is required");
  if (!options.bodyFile && !options.body) throw new Error("GitHub PR review comment body or bodyFile is required");

  const args = [
    "api",
    `repos/{owner}/{repo}/pulls/${options.pr}/comments`,
    "--method",
    "POST",
    "--field",
    options.bodyFile ? `body=@${options.bodyFile}` : `body=${options.body}`,
    "--field",
    `commit_id=${options.commitId}`,
    "--field",
    `path=${options.path}`,
    "--field",
    `line=${Number(options.line)}`,
    "--field",
    `side=${options.side || "RIGHT"}`
  ];
  if (options.startLine) args.push("--field", `start_line=${Number(options.startLine)}`);
  if (options.startSide) args.push("--field", `start_side=${options.startSide}`);
  if (options.subjectType) args.push("--field", `subject_type=${options.subjectType}`);
  return args;
}

export function buildGhRunListArgs(options = {}) {
  const args = [
    "run",
    "list",
    "--limit",
    String(options.limit || 10),
    "--json",
    "databaseId,status,conclusion,name,headBranch,event,workflowName,url,createdAt,updatedAt"
  ];
  if (options.branch) args.push("--branch", options.branch);
  if (options.workflow) args.push("--workflow", options.workflow);
  return args;
}

function normalizeLimit(limit, total) {
  if (limit === undefined || limit === null || limit === true) return total;
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 0) throw new Error("GitHub PR review comments limit must be a non-negative integer");
  return Math.min(value, total);
}

function isMissingGh(error) {
  return error?.code === "ENOENT" || /ENOENT|not recognized|not found/i.test(error?.message || "");
}

function resolveToken(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

function policyAllowedOutcome(policy, options = {}) {
  return policy.status === "allow" || (policy.status === "require_confirmation" && options.confirmed);
}

function checkOptionalCommandPolicy(root, command, options = {}, operation = "github_command") {
  if (!options.engine) return null;
  const policy = options.engine.checkCommand(command);
  appendAuditEvent(root, options.engine, options.auditLog, {
    operation,
    command,
    policyStatus: policy.status,
    outcome: policyAllowedOutcome(policy, options) ? "allowed" : "blocked",
    reason: policy.reason
  }, { confirmed: options.confirmed });
  assertPolicyAllowed(policy, { confirmed: options.confirmed });
  return policy;
}

function currentBranch(root, options = {}) {
  checkOptionalCommandPolicy(root, GITHUB_CURRENT_BRANCH_COMMAND, options, "github_current_branch");
  return execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
}

function resolveInsideRoot(root, filePath) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(absoluteRoot, filePath);
  const relative = path.relative(absoluteRoot, absolute);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(`Path escapes repository root: ${filePath}`);
  }
  return absolute;
}

function checkBodyFileReadPolicy(root, bodyFile, options = {}) {
  if (!options.engine) return null;
  const policy = options.engine.checkPath(bodyFile, "read_github_body");
  appendAuditEvent(root, options.engine, options.auditLog, {
    operation: "read_github_body",
    target: bodyFile,
    policyStatus: policy.status,
    outcome: policyAllowedOutcome(policy, options) ? "allowed" : "blocked",
    reason: policy.reason
  }, { confirmed: options.confirmed });
  assertPolicyAllowed(policy, { confirmed: options.confirmed });
  return policy;
}

function readBody(root, options = {}) {
  if (options.body) return options.body;
  if (!options.bodyFile) return "";
  checkBodyFileReadPolicy(root, options.bodyFile, options);
  const bodyPath = resolveInsideRoot(root, options.bodyFile);
  return fs.readFileSync(bodyPath, "utf8");
}

async function githubApiRequest(root, apiOptions = {}) {
  const env = apiOptions.env || process.env;
  const token = resolveToken(env);
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required for GitHub REST API fallback");

  const repository = apiOptions.repository || detectGitHubRepository(root, apiOptions);
  const baseUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = apiOptions.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error("fetch is required for GitHub REST API fallback");

  const response = await fetchImpl(`${baseUrl}/repos/${repository.owner}/${repository.repo}${apiOptions.path}`, {
    method: apiOptions.method || "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28"
    },
    body: apiOptions.body ? JSON.stringify(apiOptions.body) : undefined
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function createPullRequestWithApi(root, options = {}) {
  if (!options.title) throw new Error("GitHub PR title is required");
  const payload = {
    title: options.title,
    body: readBody(root, options),
    base: options.base || "main",
    head: options.head || currentBranch(root, options),
    draft: Boolean(options.draft)
  };
  const data = await githubApiRequest(root, {
    ...options,
    method: "POST",
    path: "/pulls",
    body: payload
  });
  return {
    status: "created",
    method: "api",
    url: data.html_url || data.url,
    number: data.number || null
  };
}

async function commentPullRequestWithApi(root, options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  const body = readBody(root, options);
  if (!body) throw new Error("GitHub PR comment body or bodyFile is required");
  const data = await githubApiRequest(root, {
    ...options,
    method: "POST",
    path: `/issues/${options.pr}/comments`,
    body: { body }
  });
  return {
    status: "commented",
    method: "api",
    url: data.html_url || data.url,
    id: data.id || null
  };
}

function reviewCommentPayload(root, options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  if (!options.commitId) throw new Error("GitHub PR review comment commitId is required");
  if (!options.path) throw new Error("GitHub PR review comment path is required");
  const line = Number(options.line);
  if (!Number.isInteger(line) || line <= 0) throw new Error("GitHub PR review comment line must be a positive integer");
  const body = readBody(root, options);
  if (!body) throw new Error("GitHub PR review comment body or bodyFile is required");

  const payload = {
    body,
    commit_id: options.commitId,
    path: options.path,
    line,
    side: options.side || "RIGHT"
  };
  if (options.startLine) payload.start_line = Number(options.startLine);
  if (options.startSide) payload.start_side = options.startSide;
  if (options.subjectType) payload.subject_type = options.subjectType;
  return payload;
}

async function createReviewCommentWithApi(root, options = {}) {
  const data = await githubApiRequest(root, {
    ...options,
    method: "POST",
    path: `/pulls/${options.pr}/comments`,
    body: reviewCommentPayload(root, options)
  });
  return {
    status: "review_commented",
    method: "api",
    url: data.html_url || data.url,
    id: data.id || null
  };
}

async function listWorkflowRunsWithApi(root, options = {}) {
  const params = new URLSearchParams({
    per_page: String(options.limit || 10)
  });
  if (options.branch) params.set("branch", options.branch);
  const data = await githubApiRequest(root, {
    ...options,
    method: "GET",
    path: `/actions/runs?${params.toString()}`
  });
  let runs = data.workflow_runs || [];
  if (options.workflow) {
    runs = runs.filter((run) => run.name === options.workflow || run.workflow_name === options.workflow);
  }
  return {
    status: "completed",
    method: "api",
    runs: runs.map((run) => ({
      databaseId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      name: run.name,
      headBranch: run.head_branch,
      event: run.event,
      workflowName: run.workflow_name || run.name,
      url: run.html_url || run.url,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    }))
  };
}

export async function createPullRequestWithGh(root = process.cwd(), options = {}) {
  const args = buildGhPrArgs(options);
  const command = `gh ${args.join(" ")}`;
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command
    };
  }
  checkOptionalCommandPolicy(root, command, options, "github_pr");
  if (options.useApi) return createPullRequestWithApi(root, options);
  try {
    const stdout = execFileSync("gh", args, { cwd: root, encoding: "utf8" });
    return {
      status: "created",
      method: "gh",
      url: stdout.trim()
    };
  } catch (error) {
    if (!isMissingGh(error) || !resolveToken(options.env)) throw error;
    return createPullRequestWithApi(root, options);
  }
}

export async function commentPullRequestWithGh(root = process.cwd(), options = {}) {
  const args = buildGhPrCommentArgs(options);
  const command = `gh ${args.join(" ")}`;
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command
    };
  }
  checkOptionalCommandPolicy(root, command, options, "github_comment");
  if (options.useApi) return commentPullRequestWithApi(root, options);
  try {
    const stdout = execFileSync("gh", args, { cwd: root, encoding: "utf8" });
    return {
      status: "commented",
      method: "gh",
      output: stdout.trim()
    };
  } catch (error) {
    if (!isMissingGh(error) || !resolveToken(options.env)) throw error;
    return commentPullRequestWithApi(root, options);
  }
}

export async function createReviewCommentWithGh(root = process.cwd(), options = {}) {
  const args = buildGhPrReviewCommentArgs(options);
  const command = `gh ${args.join(" ")}`;
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command
    };
  }
  checkOptionalCommandPolicy(root, command, options, "github_review_comment");
  if (options.useApi) return createReviewCommentWithApi(root, options);
  try {
    const stdout = execFileSync("gh", args, { cwd: root, encoding: "utf8" });
    return {
      status: "review_commented",
      method: "gh",
      output: stdout.trim()
    };
  } catch (error) {
    if (!isMissingGh(error) || !resolveToken(options.env)) throw error;
    return createReviewCommentWithApi(root, options);
  }
}

export async function createReviewCommentsWithGh(root = process.cwd(), options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  if (!options.commitId) throw new Error("GitHub PR review comment commitId is required");
  if (!Array.isArray(options.comments)) throw new Error("GitHub PR review comments must be an array");

  const limit = normalizeLimit(options.limit, options.comments.length);
  const selected = options.comments.slice(0, limit);
  if (selected.length === 0) {
    return {
      status: "no_comments",
      count: 0,
      totalReviewComments: options.comments.length,
      skipped: options.comments.length,
      comments: []
    };
  }

  const results = [];
  for (const [index, comment] of selected.entries()) {
    const result = await createReviewCommentWithGh(root, {
      pr: options.pr,
      commitId: options.commitId,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      startLine: comment.startLine,
      startSide: comment.startSide,
      subjectType: comment.subjectType,
      body: comment.body,
      env: options.env,
      dryRun: options.dryRun,
      useApi: options.useApi,
      fetch: options.fetch,
      engine: options.engine,
      confirmed: options.confirmed,
      auditLog: options.auditLog
    });
    results.push({
      index: index + 1,
      path: comment.path,
      line: comment.line,
      side: comment.side || "RIGHT",
      severity: comment.severity,
      category: comment.category,
      ...result
    });
  }

  return {
    status: options.dryRun === false ? "review_comments_published" : "dry_run",
    count: results.length,
    totalReviewComments: options.comments.length,
    skipped: options.comments.length - results.length,
    comments: results
  };
}

export function checkGitHubCommandsPolicy(items = [], engine, options = {}) {
  const confirmed = Boolean(options.confirmed);
  const commandPolicies = items
    .filter((item) => item.command)
    .map((item) => ({
      index: item.index,
      command: item.command,
      policy: engine.checkCommand(item.command)
    }));
  const blocked = commandPolicies.find(({ policy }) =>
    policy.status !== "allow" && !(policy.status === "require_confirmation" && confirmed)
  );
  if (blocked) {
    return {
      status: blocked.policy.status,
      stage: options.stage || "github_command_policy",
      index: blocked.index,
      command: blocked.command,
      policy: blocked.policy,
      commandPolicies
    };
  }
  return {
    status: "allow",
    stage: options.stage || "github_command_policy",
    commandPolicies
  };
}

export async function listWorkflowRunsWithGh(root = process.cwd(), options = {}) {
  const args = buildGhRunListArgs(options);
  const command = `gh ${args.join(" ")}`;
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command
    };
  }
  checkOptionalCommandPolicy(root, command, options, "github_checks");
  if (options.useApi) return listWorkflowRunsWithApi(root, options);

  try {
    const stdout = execFileSync("gh", args, { cwd: root, encoding: "utf8" });
    return {
      status: "completed",
      method: "gh",
      runs: JSON.parse(stdout)
    };
  } catch (error) {
    if (!isMissingGh(error) || !resolveToken(options.env)) throw error;
    return listWorkflowRunsWithApi(root, options);
  }
}
