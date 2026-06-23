import { execFileSync } from "node:child_process";
import { assertPolicyAllowed } from "../policy/safeWrite.js";
import { validateUnifiedDiff } from "./validatePatch.js";

export function applyPatchWithPolicy(root, patchText, engine, options = {}) {
  const validation = validateUnifiedDiff(patchText);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const policy = engine.checkPatch(patchText);
  assertPolicyAllowed(policy, { confirmed: options.confirmed });

  execFileSync("git", ["apply", "--check"], {
    cwd: root,
    input: patchText,
    encoding: "utf8"
  });

  if (!options.checkOnly) {
    execFileSync("git", ["apply"], {
      cwd: root,
      input: patchText,
      encoding: "utf8"
    });
  }

  return {
    status: options.checkOnly ? "checked" : "applied",
    validation,
    policy
  };
}
