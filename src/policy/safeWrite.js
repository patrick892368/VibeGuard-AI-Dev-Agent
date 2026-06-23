import fs from "node:fs";
import path from "node:path";

export function assertPolicyAllowed(result, options = {}) {
  if (result.status === "deny") {
    throw new Error(`${result.reason}: ${result.path || result.command}`);
  }
  if (result.status === "require_confirmation" && !options.confirmed) {
    throw new Error(`${result.reason}: ${result.path || result.command}`);
  }
}

export function writeFileWithPolicy(root, relativePath, content, engine, options = {}) {
  const result = engine.checkPath(relativePath, "write");
  assertPolicyAllowed(result, options);
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, "utf8");
  return {
    path: relativePath,
    policy: result
  };
}
