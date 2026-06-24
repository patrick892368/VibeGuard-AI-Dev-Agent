import { execFileSync } from "node:child_process";

export function parseGitHubRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2], url: `https://github.com/${https[1]}/${https[2]}` };

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2], url: `https://github.com/${ssh[1]}/${ssh[2]}` };

  return null;
}

export function detectGitHubRepository(root = process.cwd()) {
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

export function createPullRequestWithGh(root = process.cwd(), options = {}) {
  const args = buildGhPrArgs(options);
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command: `gh ${args.join(" ")}`
    };
  }
  const stdout = execFileSync("gh", args, { cwd: root, encoding: "utf8" });
  return {
    status: "created",
    url: stdout.trim()
  };
}

export function commentPullRequestWithGh(root = process.cwd(), options = {}) {
  const args = buildGhPrCommentArgs(options);
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command: `gh ${args.join(" ")}`
    };
  }
  const stdout = execFileSync("gh", args, { cwd: root, encoding: "utf8" });
  return {
    status: "commented",
    output: stdout.trim()
  };
}

export function listWorkflowRunsWithGh(root = process.cwd(), options = {}) {
  const args = buildGhRunListArgs(options);
  if (options.dryRun !== false) {
    return {
      status: "dry_run",
      command: `gh ${args.join(" ")}`
    };
  }

  const stdout = execFileSync("gh", args, { cwd: root, encoding: "utf8" });
  return {
    status: "completed",
    runs: JSON.parse(stdout)
  };
}
