import fs from "node:fs";
import path from "node:path";
import { appendAuditEvent } from "../policy/audit.js";
import { assertPolicyAllowed } from "../policy/safeWrite.js";
import { runArgvWithPolicy } from "../runner/safeCommand.js";

export const GITHUB_DETECT_COMMAND = "git remote get-url origin";
export const GITHUB_CURRENT_BRANCH_COMMAND = "git branch --show-current";
export const GITHUB_PR_HEAD_FIELDS = "headRefOid,headRefName";

export function parseGitHubRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2], url: `https://github.com/${https[1]}/${https[2]}` };

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2], url: `https://github.com/${ssh[1]}/${ssh[2]}` };

  return null;
}

export function detectGitHubRepository(root = process.cwd(), options = {}) {
  requireExecutionPolicy(options, "GitHub detection");
  const result = runProtectedArgv(root, ["git", "remote", "get-url", "origin"], options);
  const remote = requirePassedStdout(result, "GitHub remote detection").trim();
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

export function buildGhPrDiffArgs(options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  return ["pr", "diff", String(options.pr)];
}

export function buildGhPrViewArgs(options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  return ["pr", "view", String(options.pr), "--json", GITHUB_PR_HEAD_FIELDS];
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

function workflowRunConclusion(run = {}) {
  const status = String(run.status || "").toLowerCase();
  const conclusion = String(run.conclusion || "").toLowerCase();
  if (status && status !== "completed") return "pending";
  if (!conclusion) return status === "completed" ? "unknown" : "pending";
  if (["success", "neutral", "skipped"].includes(conclusion)) return "success";
  if (["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(conclusion)) return "failure";
  return "unknown";
}

function workflowRunLabel(run = {}) {
  return run.workflowName || run.name || `run ${run.databaseId || "unknown"}`;
}

function compactWorkflowRun(run = {}) {
  return {
    databaseId: run.databaseId ?? null,
    name: workflowRunLabel(run),
    status: run.status || null,
    conclusion: run.conclusion || null,
    headBranch: run.headBranch || null,
    url: run.url || null
  };
}

export function summarizeWorkflowRuns(runs = []) {
  const counts = {
    total: runs.length,
    success: 0,
    failure: 0,
    pending: 0,
    unknown: 0
  };
  const failingRuns = [];
  const pendingRuns = [];
  const unknownRuns = [];

  for (const run of runs) {
    const normalized = workflowRunConclusion(run);
    counts[normalized] += 1;
    if (normalized === "failure") failingRuns.push(compactWorkflowRun(run));
    if (normalized === "pending") pendingRuns.push(compactWorkflowRun(run));
    if (normalized === "unknown") unknownRuns.push(compactWorkflowRun(run));
  }

  let status = "passing";
  let gate = "pass";
  let conclusion = "success";
  if (runs.length === 0) {
    status = "no_runs";
    gate = "unknown";
    conclusion = "no_runs";
  } else if (failingRuns.length > 0) {
    status = "failing";
    gate = "fail";
    conclusion = "failure";
  } else if (pendingRuns.length > 0) {
    status = "pending";
    gate = "wait";
    conclusion = "pending";
  } else if (unknownRuns.length > 0) {
    status = "unknown";
    gate = "unknown";
    conclusion = "unknown";
  }

  return {
    status,
    gate,
    conclusion,
    counts,
    latestRun: runs[0] ? compactWorkflowRun(runs[0]) : null,
    failingRuns,
    pendingRuns,
    unknownRuns,
    summary: `CI ${status}: ${counts.success} passing, ${counts.failure} failing, ${counts.pending} pending, ${counts.unknown} unknown.`
  };
}

function waitForTerminalGate(summary = {}) {
  return summary.gate === "pass" || summary.gate === "fail";
}

function normalizeWaitOptions(options = {}) {
  const wait = Boolean(options.wait);
  const timeoutMs = Number.isFinite(Number(options.waitTimeoutMs)) ? Math.max(0, Number(options.waitTimeoutMs)) : 10 * 60 * 1000;
  const intervalMs = Number.isFinite(Number(options.waitIntervalMs)) ? Math.max(0, Number(options.waitIntervalMs)) : 10 * 1000;
  const maxAttempts = Number.isInteger(Number(options.waitMaxAttempts)) && Number(options.waitMaxAttempts) > 0
    ? Number(options.waitMaxAttempts)
    : null;
  return { wait, timeoutMs, intervalMs, maxAttempts };
}

function withWaitStatus(result, waitOptions, status, attempts, startedAt) {
  if (!waitOptions.wait) return result;
  return {
    ...result,
    wait: {
      enabled: true,
      status,
      attempts,
      elapsedMs: Date.now() - startedAt,
      timeoutMs: waitOptions.timeoutMs,
      intervalMs: waitOptions.intervalMs,
      gate: result.summary?.gate || null
    }
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLimit(limit, total) {
  if (limit === undefined || limit === null || limit === true) return total;
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 0) throw new Error("GitHub PR review comments limit must be a non-negative integer");
  return Math.min(value, total);
}

function firstLine(...texts) {
  for (const text of texts) {
    const line = String(text || "").split(/\r?\n/).find(Boolean);
    if (line) return line;
  }
  return null;
}

function isMissingGhResult(result) {
  return /ENOENT|not recognized|not found/i.test(`${result?.error || ""}\n${result?.stderr || ""}`);
}

function isGitHubAuthFailureResult(result) {
  return /authentication required|not logged in|gh auth login|bad credentials|HTTP 401|requires authentication/i.test(
    `${result?.stdout || ""}\n${result?.stderr || ""}\n${result?.error || ""}`
  );
}

function runProtectedArgv(root, argv, options = {}) {
  return runArgvWithPolicy(root, argv, options.engine, {
    confirmed: options.confirmed,
    auditLog: options.auditLog
  });
}

function requirePassedStdout(result, operation) {
  if (result.status === "passed") return result.stdout || "";
  const detail = firstLine(result.stderr, result.error, result.stdout) || `exit code ${result.exitCode}`;
  const error = new Error(`${operation} failed: ${detail}`);
  error.result = result;
  throw error;
}

function resolveToken(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

function githubWriteAuthRequired(operation, env = process.env, detail = null) {
  const tokenSources = [
    { name: "GITHUB_TOKEN", present: Boolean(env.GITHUB_TOKEN) },
    { name: "GH_TOKEN", present: Boolean(env.GH_TOKEN) }
  ];
  return {
    status: "auth_required",
    stage: "github_auth",
    operation,
    reason: "GitHub write execution requires GITHUB_TOKEN/GH_TOKEN or an authenticated gh CLI.",
    detail,
    githubAuth: {
      hasToken: tokenSources.some((source) => source.present),
      tokenSources,
      canWrite: false
    },
    nextActions: [
      {
        id: "enable_github_execution",
        reason: "Neither an authenticated gh CLI nor GITHUB_TOKEN/GH_TOKEN is available for real GitHub PR/comment/review-comment writes.",
        command: "Install and authenticate gh with `gh auth login`, or set GITHUB_TOKEN/GH_TOKEN"
      }
    ]
  };
}

function isReadOnlyApiMethod(method) {
  return ["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
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

function requireExecutionPolicy(options = {}, operation = "GitHub execution") {
  if (!options.engine) {
    throw new Error(`${operation} requires a PolicyEngine`);
  }
}

function currentBranch(root, options = {}) {
  const result = runProtectedArgv(root, ["git", "branch", "--show-current"], options);
  return requirePassedStdout(result, "GitHub current branch detection").trim();
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
  const method = String(apiOptions.method || "GET").toUpperCase();
  if (!token && !isReadOnlyApiMethod(method)) {
    throw new Error("GITHUB_TOKEN or GH_TOKEN is required for GitHub REST API write fallback");
  }

  const repository = apiOptions.repository || detectGitHubRepository(root, apiOptions);
  const baseUrl = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const fetchImpl = apiOptions.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error("fetch is required for GitHub REST API fallback");
  const headers = {
    accept: apiOptions.accept || "application/vnd.github+json",
    "x-github-api-version": "2022-11-28"
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiOptions.body) headers["content-type"] = "application/json";

  const response = await fetchImpl(`${baseUrl}/repos/${repository.owner}/${repository.repo}${apiOptions.path}`, {
    method,
    headers,
    body: apiOptions.body ? JSON.stringify(apiOptions.body) : undefined
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}`);
  }
  if (response.status === 204) return null;
  if (apiOptions.responseType === "text") return response.text();
  return response.json();
}

async function getPullRequestDiffWithApi(root, options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  const diff = await githubApiRequest(root, {
    ...options,
    method: "GET",
    path: `/pulls/${options.pr}`,
    accept: "application/vnd.github.v3.diff",
    responseType: "text"
  });
  return {
    status: "fetched",
    method: "api",
    pr: Number(options.pr),
    diff
  };
}

async function getPullRequestHeadWithApi(root, options = {}) {
  if (!options.pr) throw new Error("GitHub PR number is required");
  const data = await githubApiRequest(root, {
    ...options,
    method: "GET",
    path: `/pulls/${options.pr}`
  });
  return {
    status: "fetched",
    method: "api",
    pr: Number(options.pr),
    headSha: data.head?.sha || null,
    headRef: data.head?.ref || null
  };
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
  requireExecutionPolicy(options, "GitHub PR creation");
  if (options.useApi) {
    checkOptionalCommandPolicy(root, command, options, "github_pr");
    if (!resolveToken(options.env)) {
      return githubWriteAuthRequired("github_pr", options.env, "GITHUB_TOKEN or GH_TOKEN is required for GitHub REST API write fallback.");
    }
    return createPullRequestWithApi(root, options);
  }
  const result = runProtectedArgv(root, ["gh", ...args], options);
  if (result.status === "passed") {
    return {
      status: "created",
      method: "gh",
      url: (result.stdout || "").trim()
    };
  }
  if (isMissingGhResult(result) && resolveToken(options.env)) {
    return createPullRequestWithApi(root, options);
  }
  if (isMissingGhResult(result)) {
    return githubWriteAuthRequired("github_pr", options.env, "gh CLI is unavailable and no GitHub token is set.");
  }
  if (isGitHubAuthFailureResult(result)) {
    return githubWriteAuthRequired("github_pr", options.env, firstLine(result.stderr, result.stdout, result.error));
  }
  requirePassedStdout(result, "GitHub PR creation");
}

export async function getPullRequestDiffWithGh(root = process.cwd(), options = {}) {
  const args = buildGhPrDiffArgs(options);
  const command = `gh ${args.join(" ")}`;
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command
    };
  }
  requireExecutionPolicy(options, "GitHub PR diff");
  if (options.useApi) {
    checkOptionalCommandPolicy(root, command, options, "github_pr_diff");
    return getPullRequestDiffWithApi(root, options);
  }
  const result = runProtectedArgv(root, ["gh", ...args], options);
  if (result.status === "passed") {
    return {
      status: "fetched",
      method: "gh",
      pr: Number(options.pr),
      diff: result.stdout || ""
    };
  }
  if (result.status === "deny" || result.status === "require_confirmation") return result;
  if (isMissingGhResult(result) && resolveToken(options.env)) {
    return getPullRequestDiffWithApi(root, options);
  }
  requirePassedStdout(result, "GitHub PR diff");
}

export async function getPullRequestHeadWithGh(root = process.cwd(), options = {}) {
  const args = buildGhPrViewArgs(options);
  const command = `gh ${args.join(" ")}`;
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command
    };
  }
  requireExecutionPolicy(options, "GitHub PR head");
  if (options.useApi) {
    checkOptionalCommandPolicy(root, command, options, "github_pr_head");
    return getPullRequestHeadWithApi(root, options);
  }
  const result = runProtectedArgv(root, ["gh", ...args], options);
  if (result.status === "passed") {
    const data = JSON.parse(result.stdout || "{}");
    return {
      status: "fetched",
      method: "gh",
      pr: Number(options.pr),
      headSha: data.headRefOid || null,
      headRef: data.headRefName || null
    };
  }
  if (result.status === "deny" || result.status === "require_confirmation") return result;
  if (isMissingGhResult(result) && resolveToken(options.env)) {
    return getPullRequestHeadWithApi(root, options);
  }
  requirePassedStdout(result, "GitHub PR head");
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
  requireExecutionPolicy(options, "GitHub PR comment");
  if (options.useApi) {
    checkOptionalCommandPolicy(root, command, options, "github_comment");
    if (!resolveToken(options.env)) {
      return githubWriteAuthRequired("github_comment", options.env, "GITHUB_TOKEN or GH_TOKEN is required for GitHub REST API write fallback.");
    }
    return commentPullRequestWithApi(root, options);
  }
  const result = runProtectedArgv(root, ["gh", ...args], options);
  if (result.status === "passed") {
    return {
      status: "commented",
      method: "gh",
      output: (result.stdout || "").trim()
    };
  }
  if (isMissingGhResult(result) && resolveToken(options.env)) {
    return commentPullRequestWithApi(root, options);
  }
  if (isMissingGhResult(result)) {
    return githubWriteAuthRequired("github_comment", options.env, "gh CLI is unavailable and no GitHub token is set.");
  }
  if (isGitHubAuthFailureResult(result)) {
    return githubWriteAuthRequired("github_comment", options.env, firstLine(result.stderr, result.stdout, result.error));
  }
  requirePassedStdout(result, "GitHub PR comment");
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
  requireExecutionPolicy(options, "GitHub PR review comment");
  if (options.useApi) {
    checkOptionalCommandPolicy(root, command, options, "github_review_comment");
    if (!resolveToken(options.env)) {
      return githubWriteAuthRequired("github_review_comment", options.env, "GITHUB_TOKEN or GH_TOKEN is required for GitHub REST API write fallback.");
    }
    return createReviewCommentWithApi(root, options);
  }
  const result = runProtectedArgv(root, ["gh", ...args], options);
  if (result.status === "passed") {
    return {
      status: "review_commented",
      method: "gh",
      output: (result.stdout || "").trim()
    };
  }
  if (isMissingGhResult(result) && resolveToken(options.env)) {
    return createReviewCommentWithApi(root, options);
  }
  if (isMissingGhResult(result)) {
    return githubWriteAuthRequired("github_review_comment", options.env, "gh CLI is unavailable and no GitHub token is set.");
  }
  if (isGitHubAuthFailureResult(result)) {
    return githubWriteAuthRequired("github_review_comment", options.env, firstLine(result.stderr, result.stdout, result.error));
  }
  requirePassedStdout(result, "GitHub PR review comment");
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
    status: options.dryRun === false
      ? results.find((result) => result.status === "auth_required")?.status || "review_comments_published"
      : "dry_run",
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

async function listWorkflowRunsOnceWithGh(root = process.cwd(), options = {}) {
  const args = buildGhRunListArgs(options);
  const command = `gh ${args.join(" ")}`;
  if (options.dryRun !== false) {
    const waitOptions = normalizeWaitOptions(options);
    const result = {
      status: "dry_run",
      command
    };
    if (waitOptions.wait) {
      result.wait = {
        enabled: true,
        status: "dry_run",
        timeoutMs: waitOptions.timeoutMs,
        intervalMs: waitOptions.intervalMs
      };
    }
    return result;
  }
  requireExecutionPolicy(options, "GitHub checks");
  if (options.useApi) {
    checkOptionalCommandPolicy(root, command, options, "github_checks");
    const result = await listWorkflowRunsWithApi(root, options);
    return {
      ...result,
      summary: summarizeWorkflowRuns(result.runs)
    };
  }

  const result = runProtectedArgv(root, ["gh", ...args], options);
  if (result.status === "passed") {
    const runs = JSON.parse(result.stdout || "[]");
    return {
      status: "completed",
      method: "gh",
      runs,
      summary: summarizeWorkflowRuns(runs)
    };
  }
  if (isMissingGhResult(result) && resolveToken(options.env)) {
    const apiResult = await listWorkflowRunsWithApi(root, options);
    return {
      ...apiResult,
      summary: summarizeWorkflowRuns(apiResult.runs)
    };
  }
  requirePassedStdout(result, "GitHub checks");
}

export async function listWorkflowRunsWithGh(root = process.cwd(), options = {}) {
  const waitOptions = normalizeWaitOptions(options);
  if (!waitOptions.wait || options.dryRun !== false) {
    return listWorkflowRunsOnceWithGh(root, options);
  }

  const sleep = options.sleep || defaultSleep;
  const startedAt = Date.now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    const result = await listWorkflowRunsOnceWithGh(root, options);
    if (waitForTerminalGate(result.summary)) {
      return withWaitStatus(result, waitOptions, "completed", attempts, startedAt);
    }

    const elapsedMs = Date.now() - startedAt;
    if ((waitOptions.maxAttempts && attempts >= waitOptions.maxAttempts) || elapsedMs >= waitOptions.timeoutMs) {
      return withWaitStatus(result, waitOptions, "timeout", attempts, startedAt);
    }
    await sleep(waitOptions.intervalMs);
  }
}
