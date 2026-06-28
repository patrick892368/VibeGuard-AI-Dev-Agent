import { spawnSync } from "node:child_process";
import { assertPolicyAllowed } from "../policy/safeWrite.js";
import { appendAuditEvent } from "../policy/audit.js";

export function commandDisplay(argv) {
  return argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

export function runCommandWithPolicy(root, command, engine, options = {}) {
  const policy = engine.checkCommand(command);
  const policyAuditLog = appendAuditEvent(root, engine, options.auditLog, {
    operation: "run_command",
    command,
    policyStatus: policy.status,
    outcome: policy.status === "allow" || (policy.status === "require_confirmation" && options.confirmed) ? "allowed" : "blocked",
    dryRun: Boolean(options.dryRun),
    reason: policy.reason
  }, options);
  assertPolicyAllowed(policy, { confirmed: options.confirmed });

  if (options.dryRun) {
    return {
      status: "checked",
      command,
      policy,
      auditLog: policyAuditLog
    };
  }

  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8"
  });

  const resultBody = {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    policy,
    auditLog: policyAuditLog
  };
  appendAuditEvent(root, engine, options.auditLog, {
    operation: "run_command_result",
    command,
    status: resultBody.status,
    exitCode: resultBody.exitCode
  }, options);
  return resultBody;
}

export function runArgvWithPolicy(root, argv, engine, options = {}) {
  const command = commandDisplay(argv);
  const policy = engine.checkCommand(command);
  const policyAuditLog = appendAuditEvent(root, engine, options.auditLog, {
    operation: "run_command",
    command,
    argv,
    policyStatus: policy.status,
    outcome: policy.status === "allow" || (policy.status === "require_confirmation" && options.confirmed) ? "allowed" : "blocked",
    dryRun: Boolean(options.dryRun),
    reason: policy.reason
  }, options);
  assertPolicyAllowed(policy, { confirmed: options.confirmed });

  if (options.dryRun) {
    return {
      status: "checked",
      command,
      argv,
      policy,
      auditLog: policyAuditLog
    };
  }

  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    shell: false,
    encoding: "utf8",
    input: options.input
  });

  const resultBody = {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    command,
    argv,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message || null,
    policy,
    auditLog: policyAuditLog
  };
  appendAuditEvent(root, engine, options.auditLog, {
    operation: "run_command_result",
    command,
    argv,
    status: resultBody.status,
    exitCode: resultBody.exitCode,
    error: resultBody.error
  }, options);
  return resultBody;
}
