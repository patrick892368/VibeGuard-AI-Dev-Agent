import { execFileSync } from "node:child_process";
import { assertPolicyAllowed } from "../policy/safeWrite.js";
import { normalizeUnifiedDiff, validateUnifiedDiff } from "./validatePatch.js";

export function applyPatchWithPolicy(root, patchText, engine, options = {}) {
  const normalizedPatch = normalizeUnifiedDiff(patchText);
  const validation = validateUnifiedDiff(normalizedPatch);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const policy = engine.checkPatch(normalizedPatch);
  assertPolicyAllowed(policy, { confirmed: options.confirmed });

  execFileSync("git", ["apply", "--check"], {
    cwd: root,
    input: normalizedPatch,
    encoding: "utf8"
  });

  if (!options.checkOnly) {
    execFileSync("git", ["apply"], {
      cwd: root,
      input: normalizedPatch,
      encoding: "utf8"
    });
  }

  return {
    status: options.checkOnly ? "checked" : "applied",
    validation,
    policy
  };
}
