import fs from "node:fs";
import path from "node:path";
import { writeFileWithPolicy } from "../policy/safeWrite.js";

const templates = {
  "pre-commit": `#!/bin/sh
set -eu

PATCH="$(git diff --cached)"
if [ -z "$PATCH" ]; then
  exit 0
fi

printf "%s" "$PATCH" | node ./bin/vibeguard.js policy check --strict --json
`,
  "pre-push": `#!/bin/sh
set -eu

node ./bin/vibeguard.js review --json >/dev/null
`,
  "commit-msg": `#!/bin/sh
set -eu

MSG_FILE="$1"
if [ ! -s "$MSG_FILE" ]; then
  echo "Empty commit message is not allowed."
  exit 1
fi
`
};

export function hookTemplate(name) {
  const template = templates[name];
  if (!template) {
    throw new Error(`Unsupported hook: ${name}`);
  }
  return template;
}

export function installHook(root, name, options = {}) {
  const relativePath = `.git/hooks/${name}`;
  if (!options.allowGitDir) {
    return {
      status: "require_confirmation",
      stage: "hook_install_git_dir_confirmation",
      hook: name,
      path: relativePath,
      reason: "Installing hooks writes to .git/hooks. Re-run with --allow-git-dir to confirm this explicit Git integration operation."
    };
  }
  if (!options.engine) {
    throw new Error("installHook requires a PolicyEngine");
  }

  const policy = options.engine.checkPath(relativePath, "install_hook");
  if (policy.status !== "allow" && !(policy.status === "require_confirmation" && options.confirmed)) {
    return {
      status: policy.status,
      stage: "hook_install_policy",
      hook: name,
      path: relativePath,
      policy
    };
  }

  const written = writeFileWithPolicy(root, relativePath, hookTemplate(name), options.engine, {
    confirmed: Boolean(options.confirmed),
    auditLog: options.auditLog
  });
  const target = path.join(root, relativePath);
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows filesystems may ignore POSIX mode bits.
  }
  return {
    status: "installed",
    hook: name,
    path: path.relative(root, target).replace(/\\/g, "/"),
    policy,
    written
  };
}

export function listHooks() {
  return Object.keys(templates).sort();
}
