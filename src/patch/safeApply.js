import { assertPolicyAllowed } from "../policy/safeWrite.js";
import { appendAuditEvent } from "../policy/audit.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "./validatePatch.js";
import { runArgvWithPolicy } from "../runner/safeCommand.js";

function assertCommandPassed(result) {
  if (result.status !== "passed") {
    throw new Error(result.stderr || result.error || `Command failed: ${result.command}`);
  }
}

export function applyPatchWithPolicy(root, patchText, engine, options = {}) {
  const normalizedPatch = normalizeUnifiedDiff(patchText);
  const validation = validateUnifiedDiff(normalizedPatch);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const policy = engine.checkPatch(normalizedPatch);
  const policyAuditLog = appendAuditEvent(root, engine, options.auditLog, {
    operation: options.checkOnly ? "check_patch" : "apply_patch",
    files: policy.files,
    validationValid: validation.valid,
    policyStatus: policy.status,
    outcome: policy.status === "allow" || (policy.status === "require_confirmation" && options.confirmed) ? "allowed" : "blocked",
    reason: policy.reason
  }, options);
  assertPolicyAllowed(policy, { confirmed: options.confirmed });

  const applyCheckCommand = runArgvWithPolicy(root, ["git", "apply", "--check"], engine, {
    confirmed: Boolean(options.confirmed),
    auditLog: options.auditLog,
    input: normalizedPatch
  });
  assertCommandPassed(applyCheckCommand);

  let applyCommand = null;
  if (!options.checkOnly) {
    applyCommand = runArgvWithPolicy(root, ["git", "apply"], engine, {
      confirmed: Boolean(options.confirmed),
      auditLog: options.auditLog,
      input: normalizedPatch
    });
    assertCommandPassed(applyCommand);
  }

  const result = {
    status: options.checkOnly ? "checked" : "applied",
    validation,
    policy,
    auditLog: policyAuditLog,
    applyCheckCommand: {
      status: applyCheckCommand.status,
      exitCode: applyCheckCommand.exitCode,
      command: applyCheckCommand.command,
      policy: applyCheckCommand.policy
    },
    applyCommand: applyCommand ? {
      status: applyCommand.status,
      exitCode: applyCommand.exitCode,
      command: applyCommand.command,
      policy: applyCommand.policy
    } : null
  };
  appendAuditEvent(root, engine, options.auditLog, {
    operation: options.checkOnly ? "check_patch_result" : "apply_patch_result",
    files: policy.files,
    status: result.status
  }, options);
  return result;
}
