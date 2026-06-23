import fs from "node:fs";
import path from "node:path";

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
  if (!options.allowGitDir) {
    throw new Error("Installing hooks writes to .git/hooks. Re-run with --allow-git-dir to confirm this explicit Git integration operation.");
  }
  const target = path.join(root, ".git", "hooks", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, hookTemplate(name), { encoding: "utf8", mode: 0o755 });
  try {
    fs.chmodSync(target, 0o755);
  } catch {
    // Windows filesystems may ignore POSIX mode bits.
  }
  return {
    status: "installed",
    hook: name,
    path: path.relative(root, target).replace(/\\/g, "/")
  };
}

export function listHooks() {
  return Object.keys(templates).sort();
}
