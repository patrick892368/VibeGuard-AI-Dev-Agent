import { spawnSync } from "node:child_process";
import { assertPolicyAllowed } from "../policy/safeWrite.js";

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
