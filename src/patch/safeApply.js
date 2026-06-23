import { execFileSync } from "node:child_process";
import { assertPolicyAllowed } from "../policy/safeWrite.js";

export function applyPatchWithPolicy(root, patchText, engine, options = {}) {
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
    policy
  };
}
