import { parsePatchFiles } from "../patch/parsePatch.js";
import { commandDisplay, runArgvWithPolicy } from "../runner/safeCommand.js";
import { createPullRequestWithGh } from "./github.js";

function summarizeCommandStatus(results) {
  if (results.some((result) => result.policy.status === "deny")) return "deny";
  if (results.some((result) => result.policy.status === "require_confirmation")) return "require_confirmation";
  return "allow";
}

export function buildFixGitPlan(options = {}) {
  const changedFiles = options.changedFiles || parsePatchFiles(options.patch || "");
  const branch = options.branch;
  const commitMessage = options.commitMessage;
  const commands = [];

  if (options.createBranch) {
    const argv = ["git", "switch", "-c", branch];
    commands.push({ step: "create_branch", argv, command: commandDisplay(argv) });
  }

  if (options.commit) {
    const addArgv = ["git", "add", ...changedFiles];
    const commitArgv = ["git", "commit", "-m", commitMessage];
    commands.push({ step: "stage_files", argv: addArgv, command: commandDisplay(addArgv) });
    commands.push({ step: "commit", argv: commitArgv, command: commandDisplay(commitArgv) });
  }

  if (options.push) {
    const pushArgv = ["git", "push", "-u", "origin", branch];
    commands.push({ step: "push_branch", argv: pushArgv, command: commandDisplay(pushArgv) });
  }

  if (options.prDryRun) {
    const prArgv = ["gh", "pr", "create", "--title", options.title, "--head", branch, "--draft"];
    if (options.bodyFile) {
      prArgv.push("--body-file", options.bodyFile);
    } else {
      prArgv.push("--body", options.body || "");
    }
    commands.push({
      step: "create_pr",
      argv: prArgv,
      command: commandDisplay(prArgv),
      bodyFile: options.bodyFile || null,
      github: {
        title: options.title,
        body: options.body || "",
        bodyFile: options.bodyFile || null,
        head: branch,
        draft: true
      }
    });
  }

  return {
    status: "dry_run",
    branch,
    commitMessage,
    changedFiles,
    commands
  };
}

export function checkGitPlanPolicy(gitPlan, engine, options = {}) {
  const results = (gitPlan?.commands || []).map((command) => ({
    step: command.step,
    command: command.command,
    policy: engine.checkCommand(command.command)
  }));
  const pathResults = (gitPlan?.commands || [])
    .filter((command) => command.bodyFile)
    .map((command) => ({
      step: command.step,
      path: command.bodyFile,
      policy: engine.checkPath(command.bodyFile, "read_pr_body")
    }));
  const rawStatus = summarizeCommandStatus([...results, ...pathResults]);
  const status = rawStatus === "require_confirmation" && options.confirmed ? "allow" : rawStatus;

  return {
    status,
    rawStatus,
    confirmed: Boolean(options.confirmed),
    results,
    pathResults
  };
}

export function executeGitPlan(root, gitPlan, engine, options = {}) {
  const policy = checkGitPlanPolicy(gitPlan, engine, { confirmed: Boolean(options.confirmed) });
  if (policy.status !== "allow") {
    return {
      status: policy.status,
      stage: "git_plan_policy",
      policy,
      results: []
    };
  }

  const results = [];
  const run = options.runArgvWithPolicy || runArgvWithPolicy;
  for (const command of gitPlan.commands || []) {
    let result;
    try {
      result = run(root, command.argv, engine, {
        confirmed: Boolean(options.confirmed),
        dryRun: Boolean(options.dryRun)
      });
    } catch (error) {
      return {
        status: "failed",
        stage: "git_plan_execute",
        failedStep: command.step,
        error: error.message,
        policy,
        results
      };
    }

    results.push({
      step: command.step,
      ...result
    });

    if (result.status !== "passed" && result.status !== "checked") {
      return {
        status: "failed",
        stage: "git_plan_execute",
        failedStep: command.step,
        policy,
        results
      };
    }
  }

  return {
    status: options.dryRun ? "dry_run" : "executed",
    stage: "git_plan_execute",
    branch: gitPlan.branch,
    policy,
    results
  };
}

export async function executeGitPlanAsync(root, gitPlan, engine, options = {}) {
  const policy = checkGitPlanPolicy(gitPlan, engine, { confirmed: Boolean(options.confirmed) });
  if (policy.status !== "allow") {
    return {
      status: policy.status,
      stage: "git_plan_policy",
      policy,
      results: []
    };
  }

  const results = [];
  const run = options.runArgvWithPolicy || runArgvWithPolicy;
  for (const command of gitPlan.commands || []) {
    let result;
    try {
      if (command.step === "create_pr" && command.github && options.useGitHubHelper !== false) {
        result = await createPullRequestWithGh(root, {
          ...command.github,
          env: options.env,
          fetch: options.fetch,
          useApi: Boolean(options.useApi),
          dryRun: Boolean(options.dryRun),
          engine,
          confirmed: Boolean(options.confirmed),
          auditLog: options.auditLog
        });
      } else {
        result = run(root, command.argv, engine, {
          confirmed: Boolean(options.confirmed),
          dryRun: Boolean(options.dryRun),
          auditLog: options.auditLog
        });
      }
    } catch (error) {
      return {
        status: "failed",
        stage: "git_plan_execute",
        failedStep: command.step,
        error: error.message,
        policy,
        results
      };
    }

    results.push({
      step: command.step,
      ...result
    });

    if (!["passed", "checked", "created", "dry_run"].includes(result.status)) {
      return {
        status: "failed",
        stage: "git_plan_execute",
        failedStep: command.step,
        policy,
        results
      };
    }
  }

  return {
    status: options.dryRun ? "dry_run" : "executed",
    stage: "git_plan_execute",
    branch: gitPlan.branch,
    policy,
    results
  };
}
