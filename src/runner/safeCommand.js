import { spawnSync } from "node:child_process";
import { assertPolicyAllowed } from "../policy/safeWrite.js";

export function commandDisplay(argv) {
  return argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

export function runCommandWithPolicy(root, command, engine, options = {}) {
  const policy = engine.checkCommand(command);
  assertPolicyAllowed(policy, { confirmed: options.confirmed });

  if (options.dryRun) {
    return {
      status: "checked",
      command,
      policy
    };
  }

  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8"
  });

  return {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    policy
  };
}

export function runArgvWithPolicy(root, argv, engine, options = {}) {
  const command = commandDisplay(argv);
  const policy = engine.checkCommand(command);
  assertPolicyAllowed(policy, { confirmed: options.confirmed });

  if (options.dryRun) {
    return {
      status: "checked",
      command,
      argv,
      policy
    };
  }

  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    shell: false,
    encoding: "utf8"
  });

  return {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    command,
    argv,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message || null,
    policy
  };
}
