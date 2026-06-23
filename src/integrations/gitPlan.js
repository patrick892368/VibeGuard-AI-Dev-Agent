import { parsePatchFiles } from "../patch/parsePatch.js";

function commandDisplay(argv) {
  return argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
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

  if (options.prDryRun) {
    const prArgv = ["gh", "pr", "create", "--title", options.title, "--head", branch, "--draft"];
    if (options.bodyFile) {
      prArgv.push("--body-file", options.bodyFile);
    } else {
      prArgv.push("--body", options.body || "");
    }
    commands.push({ step: "create_pr", argv: prArgv, command: commandDisplay(prArgv) });
  }

  return {
    status: "dry_run",
    branch,
    commitMessage,
    changedFiles,
    commands
  };
}
