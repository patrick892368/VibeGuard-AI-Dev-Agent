import { execFileSync } from "node:child_process";
import { assertPolicyAllowed } from "../policy/safeWrite.js";
import { appendAuditEvent } from "../policy/audit.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "./validatePatch.js";

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

  execFileSync("git", ["apply", "--check"], {
    cwd: root,
    input: normalizedPatch,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });

  if (!options.checkOnly) {
    execFileSync("git", ["apply"], {
      cwd: root,
      input: normalizedPatch,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"]
    });
  }

  const result = {
    status: options.checkOnly ? "checked" : "applied",
    validation,
    policy,
    auditLog: policyAuditLog
  };
  appendAuditEvent(root, engine, options.auditLog, {
    operation: options.checkOnly ? "check_patch_result" : "apply_patch_result",
    files: policy.files,
    status: result.status
  }, options);
  return result;
}
